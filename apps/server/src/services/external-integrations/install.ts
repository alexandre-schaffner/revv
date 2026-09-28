// ── External integration install mechanics ──────────────────────────────────
//
// Filesystem operations that place Revv's stdio MCP bridge and credential
// where each coding agent can pick them up:
//
//   - claude-code: an account-scoped plugin directory under `~/.claude/skills`
//                  with its own `.mcp.json` and workflow skill.
//   - codex:       an account-scoped managed block in `config.toml` plus a
//                  matching `/revv-address-feedback-<account>` prompt.
//   - opencode:    an account-scoped MCP entry and matching command.
//   - cursor:      an account-scoped entry in `~/.cursor/mcp.json`.
//
// Every install is convergent (reconnect yields the same end state with a
// rotated credential), isolated by a digest of the Revv account id, and
// refuses to replace files it does not own. Paths are derived from an explicit
// home directory so tests run inside temp dirs.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExternalAgentProvider } from "@revv/shared";
import { ExternalIntegrationError } from "../../domain/errors";

const MANAGED_MARKER = ".revv-managed";
const MANAGED_COMMENT = "Managed by Revv.";
const GUIDE_DESCRIPTION =
  "Use when implementing or responding to review feedback from Revv, including walkthrough issues and reviewer comment threads.";

export function externalIntegrationError(
  code: ExternalIntegrationError["code"],
  message: string,
  cause?: unknown,
): ExternalIntegrationError {
  return new ExternalIntegrationError({ message, code, ...(cause === undefined ? {} : { cause }) });
}

// ── Asset locations ─────────────────────────────────────────────────────────

/** Locate the repository's `integrations/` directory (dev and packaged). */
export function findIntegrationsDirectory(): string {
  const override = process.env.REVV_INTEGRATIONS_DIR?.trim();
  const candidates = [
    override,
    resolve(import.meta.dir, "../../../../../integrations"),
    resolve(process.cwd(), "integrations"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const found = candidates.find((candidate) =>
    existsSync(join(candidate, "external-mcp-bridge", "revv-mcp.ts")),
  );
  if (!found) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      "The bundled Revv integration assets could not be found. Update or reinstall Revv.",
    );
  }
  return found;
}

function bridgeSourceFile(integrationsDirectory: string): string {
  return join(integrationsDirectory, "external-mcp-bridge", "revv-mcp.ts");
}

function agentGuideSourceFile(integrationsDirectory: string): string {
  return join(integrationsDirectory, "external-agent-guides", "address-feedback.md");
}

// ── Shared install primitives ───────────────────────────────────────────────

export interface BridgeInstallInput {
  readonly runtimeExecutable: string;
  readonly token: string;
  readonly integrationsDirectory: string;
}

/** Filesystem/config key that reveals no raw account identifier. */
export function externalIntegrationAccountKey(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex").slice(0, 12);
}

function assertRevvManaged(directory: string): void {
  if (!existsSync(directory)) return;
  if (!existsSync(join(directory, MANAGED_MARKER))) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `Refusing to replace the existing non-Revv directory at ${directory}. Move it aside and retry.`,
    );
  }
}

/** Atomic, convergent directory replacement used by every provider install. */
function writeManagedDirectory(targetDirectory: string, populate: (staged: string) => void): void {
  assertRevvManaged(targetDirectory);
  mkdirSync(dirname(targetDirectory), { recursive: true, mode: 0o700 });

  const suffix = randomUUID();
  const staged = `${targetDirectory}.staged-${suffix}`;
  const backup = `${targetDirectory}.backup-${suffix}`;
  try {
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    populate(staged);
    writeFileSync(join(staged, MANAGED_MARKER), `${MANAGED_COMMENT}\n`, { mode: 0o600 });

    if (existsSync(targetDirectory)) {
      renameSync(targetDirectory, backup);
    }
    renameSync(staged, targetDirectory);
    if (existsSync(backup)) rmSync(backup, { recursive: true });
  } catch (cause) {
    if (existsSync(staged)) rmSync(staged, { recursive: true });
    if (!existsSync(targetDirectory) && existsSync(backup)) {
      renameSync(backup, targetDirectory);
    }
    throw cause;
  }
}

function removeManagedDirectory(directory: string): void {
  if (!existsSync(directory)) return;
  assertRevvManaged(directory);
  rmSync(directory, { recursive: true });
}

/** Copy the canonical bridge into a staged install directory. */
function stageBridge(staged: string, integrationsDirectory: string): void {
  const target = join(staged, "server", "revv-mcp.ts");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(bridgeSourceFile(integrationsDirectory), target);
  chmodSync(target, 0o600);
}

/** Absolute path of the bridge a provider's client config should launch. */
function bridgeFile(installDirectory: string): string {
  return join(installDirectory, "server", "revv-mcp.ts");
}

function readTextIfExists(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function writePrivateTextFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.staged-${randomUUID()}`;
  try {
    writeFileSync(staged, content, { mode: 0o600 });
    chmodSync(staged, 0o600);
    // Same-directory rename is atomic on the desktop platforms Revv ships.
    // A crash can leave the old file or the complete new file, never a
    // truncated config containing only part of the user's other settings.
    renameSync(staged, file);
    chmodSync(file, 0o600);
  } catch (cause) {
    if (existsSync(staged)) rmSync(staged);
    throw cause;
  }
}

function readManagedGuideBody(integrationsDirectory: string): string {
  const file = agentGuideSourceFile(integrationsDirectory);
  if (!existsSync(file)) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      "The bundled Revv agent guide could not be found. Update or reinstall Revv.",
    );
  }
  return readFileSync(file, "utf8").trim();
}

/** Front-matter + body, in the shape the given agent's prompt loader expects. */
function renderGuide(integrationsDirectory: string, frontMatter: readonly string[]): string {
  const body = readManagedGuideBody(integrationsDirectory);
  const header = frontMatter.length > 0 ? `---\n${frontMatter.join("\n")}\n---\n\n` : "";
  return `${header}<!-- ${MANAGED_COMMENT} Reconnect from Revv Settings to refresh. -->\n\n${body}\n`;
}

function writeManagedGuide(file: string, content: string): void {
  const existing = readTextIfExists(file);
  if (existing !== null && !existing.includes(MANAGED_COMMENT)) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `Refusing to replace the existing non-Revv file at ${file}. Move it aside and retry.`,
    );
  }
  writePrivateTextFile(file, content);
}

function removeManagedGuide(file: string): void {
  const existing = readTextIfExists(file);
  if (existing === null) return;
  if (!existing.includes(MANAGED_COMMENT)) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `Refusing to remove the non-Revv file at ${file}. Move it aside and retry.`,
    );
  }
  rmSync(file);
}

// ── Claude Code (user-scoped plugin directory) ──────────────────────────────

interface ClaudeCodePaths {
  /** Claude Code loads `~/.claude/skills/<dir>` holding a plugin manifest as
   *  a user-scoped plugin, which is what gives the MCP server a stable name. */
  readonly installDir: string;
}

export function claudeCodePaths(accountKey: string, home: string = homedir()): ClaudeCodePaths {
  return { installDir: join(home, ".claude", "skills", `revv-${accountKey}`) };
}

function installClaudeCode(
  input: BridgeInstallInput,
  paths: ClaudeCodePaths,
  serverName: string,
): void {
  const sourceDirectory = join(input.integrationsDirectory, "claude-code-plugin");
  if (!existsSync(join(sourceDirectory, ".claude-plugin", "plugin.json"))) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      "The bundled Revv Claude Code plugin could not be found. Update or reinstall Revv.",
    );
  }
  const pluginRoot = `$${"{CLAUDE_PLUGIN_ROOT}"}`;
  writeManagedDirectory(paths.installDir, (staged) => {
    cpSync(sourceDirectory, staged, { recursive: true });
    const manifestFile = join(staged, ".claude-plugin", "plugin.json");
    const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw externalIntegrationError(
        "INSTALL_FAILED",
        "The bundled Claude Code plugin manifest is invalid. Update or reinstall Revv.",
      );
    }
    writePrivateTextFile(
      manifestFile,
      `${JSON.stringify({ ...manifest, name: serverName }, null, 2)}\n`,
    );
    stageBridge(staged, input.integrationsDirectory);
    writePrivateTextFile(
      join(staged, "skills", "address-feedback", "SKILL.md"),
      renderGuide(input.integrationsDirectory, [`description: ${GUIDE_DESCRIPTION}`]),
    );
    const config = {
      mcpServers: {
        review: {
          command: input.runtimeExecutable,
          args: ["run", `${pluginRoot}/server/revv-mcp.ts`],
          env: {
            REVV_INTEGRATION_TOKEN: input.token,
          },
        },
      },
    };
    writeFileSync(join(staged, ".mcp.json"), `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
  });
}

// ── Codex (config.toml managed block + custom prompt) ───────────────────────

export interface CodexPaths {
  readonly installDir: string;
  readonly configFile: string;
  readonly promptFile: string;
}

export function codexPaths(accountKey: string, home: string = homedir()): CodexPaths {
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  return {
    installDir: join(home, ".revv", "codex", accountKey),
    configFile: join(codexHome, "config.toml"),
    promptFile: join(codexHome, "prompts", `revv-address-feedback-${accountKey}.md`),
  };
}

function codexBlockBegin(serverName: string): string {
  return `# >>> ${serverName} managed >>>`;
}

function codexBlockEnd(serverName: string): string {
  return `# <<< ${serverName} managed <<<`;
}

function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderCodexManagedBlock(
  input: BridgeInstallInput,
  installDir: string,
  serverName: string,
): string {
  return [
    codexBlockBegin(serverName),
    `[mcp_servers.${serverName}]`,
    `command = ${tomlBasicString(input.runtimeExecutable)}`,
    `args = ["run", ${tomlBasicString(bridgeFile(installDir))}]`,
    "",
    `[mcp_servers.${serverName}.env]`,
    `REVV_INTEGRATION_TOKEN = ${tomlBasicString(input.token)}`,
    codexBlockEnd(serverName),
  ].join("\n");
}

function managedBlockSpan(
  content: string,
  serverName: string,
): { begin: number; end: number } | null {
  const blockBegin = codexBlockBegin(serverName);
  const blockEnd = codexBlockEnd(serverName);
  const begin = content.indexOf(blockBegin);
  const end = content.indexOf(blockEnd);
  if (begin === -1 && end === -1) return null;
  if (begin === -1 || end === -1 || end <= begin) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      "The Revv-managed section of the Codex config.toml is damaged. Remove the partial revv markers and reconnect.",
    );
  }
  return { begin, end: end + blockEnd.length };
}

function mergeCodexConfig(existing: string | null, block: string, serverName: string): string {
  if (existing === null || existing.trim() === "") return `${block}\n`;
  const span = managedBlockSpan(existing, serverName);
  if (span) {
    const before = existing.slice(0, span.begin).replace(/\s+$/, "");
    const after = existing.slice(span.end).replace(/^\s+/, "");
    return `${[before, block, after].filter(Boolean).join("\n\n")}\n`;
  }
  if (new RegExp(`^\\s*\\[mcp_servers\\.${serverName}(?:\\.|\\])`, "m").test(existing)) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `The Codex config.toml already has an [mcp_servers.${serverName}] section that Revv did not create. Remove it and reconnect.`,
    );
  }
  return `${existing.replace(/\s+$/, "")}\n\n${block}\n`;
}

function stripCodexManagedBlock(existing: string, serverName: string): string {
  const span = managedBlockSpan(existing, serverName);
  if (!span) return existing;
  const before = existing.slice(0, span.begin).replace(/\s+$/, "");
  const after = existing.slice(span.end).replace(/^\s+/, "");
  const merged = [before, after].filter(Boolean).join("\n\n");
  return merged === "" ? "" : `${merged}\n`;
}

function installCodex(input: BridgeInstallInput, paths: CodexPaths, serverName: string): void {
  writeManagedDirectory(paths.installDir, (staged) => {
    stageBridge(staged, input.integrationsDirectory);
  });
  writePrivateTextFile(
    paths.configFile,
    mergeCodexConfig(
      readTextIfExists(paths.configFile),
      renderCodexManagedBlock(input, paths.installDir, serverName),
      serverName,
    ),
  );
  // Codex custom prompts are plain markdown; it has no front-matter contract.
  writeManagedGuide(paths.promptFile, renderGuide(input.integrationsDirectory, []));
}

function uninstallCodex(paths: CodexPaths, serverName: string): void {
  const existing = readTextIfExists(paths.configFile);
  if (existing !== null) {
    writePrivateTextFile(paths.configFile, stripCodexManagedBlock(existing, serverName));
  }
  removeManagedGuide(paths.promptFile);
  removeManagedDirectory(paths.installDir);
}

function codexInstalled(paths: CodexPaths, serverName: string): boolean {
  const existing = readTextIfExists(paths.configFile);
  return existing?.includes(codexBlockBegin(serverName)) ?? false;
}

// ── Shared JSON config merge (OpenCode, Cursor) ─────────────────────────────

function isRevvManagedEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  for (const key of ["env", "environment"]) {
    const env = record[key];
    if (env !== null && typeof env === "object" && !Array.isArray(env)) {
      if ("REVV_INTEGRATION_TOKEN" in (env as Record<string, unknown>)) return true;
    }
  }
  return false;
}

function readJsonConfig(file: string): Record<string, unknown> {
  const existing = readTextIfExists(file);
  if (existing === null || existing.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `Could not parse ${file}. Fix the file (or remove comments/trailing commas) and reconnect.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `Expected ${file} to contain a JSON object. Fix the file and reconnect.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Key path to the object holding MCP servers: `["mcpServers"]`, `["mcp", "servers"]`. */
type McpSection = readonly [string, ...string[]];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Walk (creating as needed) to the section's object, refusing a non-object on the way. */
function ensureSection(
  config: Record<string, unknown>,
  section: McpSection,
): Record<string, unknown> {
  let parent = config;
  for (const key of section) {
    const value = parent[key];
    if (value === undefined) {
      const created: Record<string, unknown> = {};
      parent[key] = created;
      parent = created;
      continue;
    }
    if (!isRecord(value)) {
      throw externalIntegrationError(
        "INSTALL_FAILED",
        `Expected "${section.join(".")}" to be an object in the MCP configuration. Fix the file and reconnect.`,
      );
    }
    parent = value;
  }
  return parent;
}

interface FoundSection {
  readonly parent: Record<string, unknown>;
  readonly key: string;
  readonly servers: Record<string, unknown>;
}

/** The section's object, with its parent and key, or undefined when any key is missing. */
function findSection(
  config: Record<string, unknown>,
  section: McpSection,
): FoundSection | undefined {
  let found: FoundSection | undefined;
  let current: unknown = config;
  for (const key of section) {
    if (!isRecord(current)) return undefined;
    const next = current[key];
    if (!isRecord(next)) return undefined;
    found = { parent: current, key, servers: next };
    current = next;
  }
  return found;
}

/** Upsert one account-scoped Revv server, refusing a foreign row at that key. */
function upsertJsonMcpEntry(
  file: string,
  section: McpSection,
  serverName: string,
  entry: Record<string, unknown>,
): void {
  const config = readJsonConfig(file);
  const servers = ensureSection(config, section);
  if (servers[serverName] !== undefined && !isRevvManagedEntry(servers[serverName])) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `${file} already has a ${section.join(".")}.${serverName} entry that Revv did not create. Remove it and reconnect.`,
    );
  }
  servers[serverName] = entry;
  writePrivateTextFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Remove Revv's server from a section. A foreign row at that key is refused
 * unless `foreign: "keep"`, which leaves it alone (used when sweeping a legacy
 * location Revv may never have written). An emptied nested section
 * (`mcp.servers`) is dropped; a top-level one is kept, as it always was.
 */
function removeJsonMcpEntry(
  file: string,
  section: McpSection,
  serverName: string,
  { foreign = "refuse" }: { readonly foreign?: "refuse" | "keep" } = {},
): void {
  const existing = readTextIfExists(file);
  if (existing === null || existing.trim() === "") return;
  const config = readJsonConfig(file);
  const found = findSection(config, section);
  if (!found) return;
  const entry = found.servers[serverName];
  if (entry === undefined) return;
  if (!isRevvManagedEntry(entry)) {
    if (foreign === "keep") return;
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `Refusing to remove the non-Revv ${section.join(".")}.${serverName} entry in ${file}.`,
    );
  }
  delete found.servers[serverName];
  if (section.length > 1 && Object.keys(found.servers).length === 0) {
    delete found.parent[found.key];
  }
  writePrivateTextFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

function jsonMcpEntryInstalled(file: string, section: McpSection, serverName: string): boolean {
  try {
    return isRevvManagedEntry(findSection(readJsonConfig(file), section)?.servers[serverName]);
  } catch {
    return false;
  }
}

// ── OpenCode (opencode.json mcp entry + global command) ─────────────────────

// opencode 2 nests MCP servers under `mcp.servers`. opencode 1 put them
// directly under `mcp`, where earlier Revv builds wrote their entry; opencode 2
// still loads that shape, so a leftover would start the bridge twice.
const OPENCODE_MCP_SECTION: McpSection = ["mcp", "servers"];
const LEGACY_OPENCODE_MCP_SECTION: McpSection = ["mcp"];

export interface OpenCodePaths {
  readonly installDir: string;
  readonly configFile: string;
  readonly commandFile: string;
  /** opencode 1's singular `command/` directory, still read by opencode 2. */
  readonly legacyCommandFile: string;
}

export function openCodePaths(accountKey: string, home: string = homedir()): OpenCodePaths {
  const configDir = join(home, ".config", "opencode");
  // Prefer the plain-JSON file; fall back to an existing JSONC file so the
  // entry lands wherever the user actually keeps their global config.
  const jsonFile = join(configDir, "opencode.json");
  const jsoncFile = join(configDir, "opencode.jsonc");
  const commandName = `revv-address-feedback-${accountKey}.md`;
  return {
    installDir: join(home, ".revv", "opencode", accountKey),
    configFile: existsSync(jsonFile) || !existsSync(jsoncFile) ? jsonFile : jsoncFile,
    commandFile: join(configDir, "commands", commandName),
    legacyCommandFile: join(configDir, "command", commandName),
  };
}

/** Drop what an opencode-1-era install left behind; foreign files are kept. */
function removeLegacyOpenCodeInstall(paths: OpenCodePaths, serverName: string): void {
  removeJsonMcpEntry(paths.configFile, LEGACY_OPENCODE_MCP_SECTION, serverName, {
    foreign: "keep",
  });
  if (readTextIfExists(paths.legacyCommandFile)?.includes(MANAGED_COMMENT)) {
    removeManagedGuide(paths.legacyCommandFile);
  }
}

function installOpenCode(
  input: BridgeInstallInput,
  paths: OpenCodePaths,
  serverName: string,
): void {
  writeManagedDirectory(paths.installDir, (staged) => {
    stageBridge(staged, input.integrationsDirectory);
  });
  upsertJsonMcpEntry(paths.configFile, OPENCODE_MCP_SECTION, serverName, {
    type: "local",
    command: [input.runtimeExecutable, "run", bridgeFile(paths.installDir)],
    environment: {
      REVV_INTEGRATION_TOKEN: input.token,
    },
  });
  writeManagedGuide(
    paths.commandFile,
    renderGuide(input.integrationsDirectory, [
      "description: Address Revv review feedback in the current checkout",
    ]),
  );
  removeLegacyOpenCodeInstall(paths, serverName);
}

function uninstallOpenCode(paths: OpenCodePaths, serverName: string): void {
  removeJsonMcpEntry(paths.configFile, OPENCODE_MCP_SECTION, serverName);
  removeManagedGuide(paths.commandFile);
  removeLegacyOpenCodeInstall(paths, serverName);
  removeManagedDirectory(paths.installDir);
}

function openCodeInstalled(paths: OpenCodePaths, serverName: string): boolean {
  return (
    jsonMcpEntryInstalled(paths.configFile, OPENCODE_MCP_SECTION, serverName) ||
    jsonMcpEntryInstalled(paths.configFile, LEGACY_OPENCODE_MCP_SECTION, serverName)
  );
}

// ── Cursor (~/.cursor/mcp.json) ─────────────────────────────────────────────

const CURSOR_MCP_SECTION: McpSection = ["mcpServers"];

export interface CursorPaths {
  readonly installDir: string;
  readonly configFile: string;
}

export function cursorPaths(accountKey: string, home: string = homedir()): CursorPaths {
  return {
    installDir: join(home, ".revv", "cursor", accountKey),
    configFile: join(home, ".cursor", "mcp.json"),
  };
}

function installCursor(input: BridgeInstallInput, paths: CursorPaths, serverName: string): void {
  writeManagedDirectory(paths.installDir, (staged) => {
    stageBridge(staged, input.integrationsDirectory);
  });
  upsertJsonMcpEntry(paths.configFile, CURSOR_MCP_SECTION, serverName, {
    type: "stdio",
    command: input.runtimeExecutable,
    args: ["run", bridgeFile(paths.installDir)],
    env: {
      REVV_INTEGRATION_TOKEN: input.token,
    },
  });
}

function uninstallCursor(paths: CursorPaths, serverName: string): void {
  removeJsonMcpEntry(paths.configFile, CURSOR_MCP_SECTION, serverName);
  removeManagedDirectory(paths.installDir);
}

// ── Provider registry ───────────────────────────────────────────────────────

export interface ExternalIntegrationInstaller {
  /** Account-scoped name shown in the agent's MCP configuration. */
  readonly clientName: string;
  /** Files and directories this install owns, shown to the user on connect. */
  readonly locations: readonly string[];
  readonly install: (input: BridgeInstallInput) => void;
  readonly uninstall: () => void;
  readonly installed: () => boolean;
}

/**
 * Bind a provider's install mechanics to a home directory. Tests pass a temp
 * directory; the service uses the real one.
 */
export function externalIntegrationInstaller(
  provider: ExternalAgentProvider,
  accountId: string,
  home: string = homedir(),
): ExternalIntegrationInstaller {
  const accountKey = externalIntegrationAccountKey(accountId);
  const serverName = `revv-${accountKey}`;
  switch (provider) {
    case "claude-code": {
      const paths = claudeCodePaths(accountKey, home);
      return {
        clientName: serverName,
        locations: [paths.installDir],
        install: (input) => installClaudeCode(input, paths, serverName),
        uninstall: () => removeManagedDirectory(paths.installDir),
        installed: () => existsSync(join(paths.installDir, MANAGED_MARKER)),
      };
    }
    case "codex": {
      const paths = codexPaths(accountKey, home);
      return {
        clientName: serverName,
        locations: [paths.configFile, paths.promptFile],
        install: (input) => installCodex(input, paths, serverName),
        uninstall: () => uninstallCodex(paths, serverName),
        installed: () => codexInstalled(paths, serverName),
      };
    }
    case "opencode": {
      const paths = openCodePaths(accountKey, home);
      return {
        clientName: serverName,
        locations: [paths.configFile, paths.commandFile],
        install: (input) => installOpenCode(input, paths, serverName),
        uninstall: () => uninstallOpenCode(paths, serverName),
        installed: () => openCodeInstalled(paths, serverName),
      };
    }
    case "cursor": {
      const paths = cursorPaths(accountKey, home);
      return {
        clientName: serverName,
        locations: [paths.configFile],
        install: (input) => installCursor(input, paths, serverName),
        uninstall: () => uninstallCursor(paths, serverName),
        installed: () => jsonMcpEntryInstalled(paths.configFile, CURSOR_MCP_SECTION, serverName),
      };
    }
  }
}
