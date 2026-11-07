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
// refuses to replace files it does not own. Paths derive from an explicit home
// directory (Codex's also from `CODEX_HOME`) so tests run inside temp dirs.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExternalAgentProvider } from "@revv/shared";
import { serverEnv } from "../../config";
import { ExternalIntegrationError } from "../../domain/errors";

const MANAGED_MARKER = ".revv-managed";
const MANAGED_COMMENT = "Managed by Revv.";
const GUIDE_DESCRIPTION =
  "Use when implementing or responding to review feedback from Revv, including walkthrough issues and reviewer comment threads, or when asking Revv to re-review pushed changes.";

export function externalIntegrationError(
  code: ExternalIntegrationError["code"],
  message: string,
  cause?: unknown,
): ExternalIntegrationError {
  return new ExternalIntegrationError({ message, code, ...(cause === undefined ? {} : { cause }) });
}

export function findIntegrationsDirectory(): string {
  const candidates = [
    serverEnv.integrationsDir,
    // Embedded by the compiled desktop server (`scripts/build-binary.ts`).
    join(import.meta.dir, "integrations"),
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

export interface BridgeInstallInput {
  readonly runtimeExecutable: string;
  readonly token: string;
  readonly integrationsDirectory: string;
  /** The installing server's own MCP route: the bridge talks to it and nothing else. */
  readonly apiUrl: string;
}

const LOOPBACK = "127.0.0.1,localhost";
const TOKEN_VARIABLE = "REVV_INTEGRATION_TOKEN";
const API_URL_VARIABLE = "REVV_API_URL";

/** What an installed bridge carries: its credential, and the server it talks to. */
export interface InstalledBinding {
  readonly token: string;
  /** Null for a config written before the bridge carried one (legacy-upgrade: unpinnedBridge). */
  readonly apiUrl: string | null;
}

/**
 * Environment for the bridge process. `runtimeExecutable` is the server's own
 * executable; in the desktop app that is the compiled Revv server, which only
 * runs `run <file>` like the Bun CLI when `BUN_BE_BUN` is set. Plain Bun
 * ignores the variable. Bun routes even loopback requests through
 * `HTTP_PROXY` unless `NO_PROXY` names the host.
 */
function bridgeEnvironment(input: BridgeInstallInput): Record<string, string> {
  return {
    [TOKEN_VARIABLE]: input.token,
    [API_URL_VARIABLE]: input.apiUrl,
    NO_PROXY: LOOPBACK,
    no_proxy: LOOPBACK,
    BUN_BE_BUN: "1",
  };
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

// The compiled desktop server embeds `integrations/` in its virtual
// filesystem, which supports reads but not `copyFile`/`cp`. Copy by content.
function copyAsset(source: string, target: string): void {
  writeFileSync(target, readFileSync(source));
}

function copyAssetTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    if (statSync(from).isDirectory()) copyAssetTree(from, to);
    else copyAsset(from, to);
  }
}

function stageBridge(staged: string, integrationsDirectory: string): void {
  const target = join(staged, "server", "revv-mcp.ts");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyAsset(bridgeSourceFile(integrationsDirectory), target);
  chmodSync(target, 0o600);
}

function bridgeFile(installDirectory: string): string {
  return join(installDirectory, "server", "revv-mcp.ts");
}

function readTextIfExists(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function writePrivateTextFile(file: string, content: string): void {
  // A boot refresh rewrites every managed file: leave unchanged ones untouched.
  if (readTextIfExists(file) === content) return;
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

function renderGuide(integrationsDirectory: string, frontMatter: readonly string[]): string {
  const body = readManagedGuideBody(integrationsDirectory);
  const header = frontMatter.length > 0 ? `---\n${frontMatter.join("\n")}\n---\n\n` : "";
  return `${header}<!-- ${MANAGED_COMMENT} Revv rewrites this file when it starts. -->\n\n${body}\n`;
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
    copyAssetTree(sourceDirectory, staged);
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
          env: bridgeEnvironment(input),
        },
      },
    };
    writeFileSync(join(staged, ".mcp.json"), `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
  });
}

export interface CodexPaths {
  readonly installDir: string;
  readonly configFile: string;
  readonly promptFile: string;
}

/** The slash command the Codex prompt and the opencode command file register. */
function addressFeedbackCommand(accountKey: string): string {
  return `revv-address-feedback-${accountKey}`;
}

export function codexPaths(accountKey: string, home: string = homedir()): CodexPaths {
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  return {
    installDir: join(home, ".revv", "codex", accountKey),
    configFile: join(codexHome, "config.toml"),
    promptFile: join(codexHome, "prompts", `${addressFeedbackCommand(accountKey)}.md`),
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
    ...Object.entries(bridgeEnvironment(input)).map(
      ([name, value]) => `${name} = ${tomlBasicString(value)}`,
    ),
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

function codexBinding(paths: CodexPaths, serverName: string): InstalledBinding | null {
  const existing = readTextIfExists(paths.configFile);
  if (existing === null) return null;
  try {
    const span = managedBlockSpan(existing, serverName);
    if (!span) return null;
    const block = existing.slice(span.begin, span.end);
    const variable = (name: string) =>
      new RegExp(`^${name} = "([^"\\\\]+)"$`, "m").exec(block)?.[1] ?? null;
    const token = variable(TOKEN_VARIABLE);
    return token === null ? null : { token, apiUrl: variable(API_URL_VARIABLE) };
  } catch {
    return null;
  }
}

function claudeCodeBinding(paths: ClaudeCodePaths): InstalledBinding | null {
  if (!existsSync(join(paths.installDir, MANAGED_MARKER))) return null;
  return jsonEntryBinding(join(paths.installDir, ".mcp.json"), "mcpServers", "review");
}

function codexInstalled(paths: CodexPaths, serverName: string): boolean {
  const existing = readTextIfExists(paths.configFile);
  return existing?.includes(codexBlockBegin(serverName)) ?? false;
}

function isRevvManagedEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  for (const key of ["env", "environment"]) {
    const env = record[key];
    if (env !== null && typeof env === "object" && !Array.isArray(env)) {
      if (TOKEN_VARIABLE in (env as Record<string, unknown>)) return true;
    }
  }
  return false;
}

function bindingIn(env: unknown): InstalledBinding | null {
  if (env === null || typeof env !== "object" || Array.isArray(env)) return null;
  const record = env as Record<string, unknown>;
  const token = record[TOKEN_VARIABLE];
  if (typeof token !== "string" || token === "") return null;
  const apiUrl = record[API_URL_VARIABLE];
  return { token, apiUrl: typeof apiUrl === "string" && apiUrl !== "" ? apiUrl : null };
}

/** The binding in Revv's entry of a JSON MCP config, or null. */
function jsonEntryBinding(
  file: string,
  section: string,
  serverName: string,
): InstalledBinding | null {
  try {
    const servers = readJsonConfig(file)[section];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return null;
    const entry = (servers as Record<string, unknown>)[serverName];
    if (!isRevvManagedEntry(entry)) return null;
    const record = entry as Record<string, unknown>;
    return bindingIn(record.env) ?? bindingIn(record.environment);
  } catch {
    return null;
  }
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

function nestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `Expected "${key}" to be an object in the MCP configuration. Fix the file and reconnect.`,
    );
  }
  return value as Record<string, unknown>;
}

function upsertJsonMcpEntry(
  file: string,
  section: string,
  serverName: string,
  entry: Record<string, unknown>,
): void {
  const config = readJsonConfig(file);
  const servers = nestedRecord(config, section);
  if (servers[serverName] !== undefined && !isRevvManagedEntry(servers[serverName])) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `${file} already has a ${section}.${serverName} entry that Revv did not create. Remove it and reconnect.`,
    );
  }
  servers[serverName] = entry;
  writePrivateTextFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

function removeJsonMcpEntry(file: string, section: string, serverName: string): void {
  const existing = readTextIfExists(file);
  if (existing === null || existing.trim() === "") return;
  const config = readJsonConfig(file);
  const servers = config[section];
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return;
  const entry = (servers as Record<string, unknown>)[serverName];
  if (entry === undefined) return;
  if (!isRevvManagedEntry(entry)) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `Refusing to remove the non-Revv ${section}.${serverName} entry in ${file}.`,
    );
  }
  delete (servers as Record<string, unknown>)[serverName];
  writePrivateTextFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

function jsonMcpEntryInstalled(file: string, section: string, serverName: string): boolean {
  try {
    const servers = readJsonConfig(file)[section];
    return (
      servers !== null &&
      typeof servers === "object" &&
      !Array.isArray(servers) &&
      isRevvManagedEntry((servers as Record<string, unknown>)[serverName])
    );
  } catch {
    return false;
  }
}

// Written in opencode 1's layout — the server directly under `mcp` with
// `enabled`, the command in `command/` — which every opencode reads: opencode 2
// normalizes such an entry into its own `mcp.servers` and scans both
// `command/` and `commands/`. opencode 2's native `mcp.servers` makes opencode
// 1 (through at least 1.18.0) reject the whole config as invalid, which takes
// down the CLI, Revv's own opencode chat and walkthroughs included.

export interface OpenCodePaths {
  readonly installDir: string;
  readonly configFile: string;
  readonly commandFile: string;
}

export function openCodePaths(accountKey: string, home: string = homedir()): OpenCodePaths {
  const configDir = join(home, ".config", "opencode");
  // Prefer the plain-JSON file; fall back to an existing JSONC file so the
  // entry lands wherever the user actually keeps their global config.
  const jsonFile = join(configDir, "opencode.json");
  const jsoncFile = join(configDir, "opencode.jsonc");
  return {
    installDir: join(home, ".revv", "opencode", accountKey),
    configFile: existsSync(jsonFile) || !existsSync(jsoncFile) ? jsonFile : jsoncFile,
    commandFile: join(configDir, "command", `${addressFeedbackCommand(accountKey)}.md`),
  };
}

function installOpenCode(
  input: BridgeInstallInput,
  paths: OpenCodePaths,
  serverName: string,
): void {
  writeManagedDirectory(paths.installDir, (staged) => {
    stageBridge(staged, input.integrationsDirectory);
  });
  upsertJsonMcpEntry(paths.configFile, "mcp", serverName, {
    type: "local",
    command: [input.runtimeExecutable, "run", bridgeFile(paths.installDir)],
    enabled: true,
    environment: bridgeEnvironment(input),
  });
  writeManagedGuide(
    paths.commandFile,
    renderGuide(input.integrationsDirectory, [
      "description: Address Revv review feedback in the current checkout",
    ]),
  );
}

function uninstallOpenCode(paths: OpenCodePaths, serverName: string): void {
  removeJsonMcpEntry(paths.configFile, "mcp", serverName);
  removeManagedGuide(paths.commandFile);
  removeManagedDirectory(paths.installDir);
}

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
  upsertJsonMcpEntry(paths.configFile, "mcpServers", serverName, {
    type: "stdio",
    command: input.runtimeExecutable,
    args: ["run", bridgeFile(paths.installDir)],
    env: bridgeEnvironment(input),
  });
}

function uninstallCursor(paths: CursorPaths, serverName: string): void {
  removeJsonMcpEntry(paths.configFile, "mcpServers", serverName);
  removeManagedDirectory(paths.installDir);
}

export interface ExternalIntegrationInstaller {
  /** Account-scoped name shown in the agent's MCP configuration. */
  readonly clientName: string;
  /** What the user still has to do in the agent itself after connecting. */
  readonly activation: string;
  /** Write every file Revv owns in the agent's config. Convergent: a re-install rewrites them. */
  readonly install: (input: BridgeInstallInput) => void;
  readonly uninstall: () => void;
  readonly installed: () => boolean;
  /** What the installed bridge carries, or null when none is installed. */
  readonly installedBinding: () => InstalledBinding | null;
}

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
        activation: `Run /reload-plugins in an open session, or restart Claude Code. Server: ${serverName}.`,
        install: (input) => installClaudeCode(input, paths, serverName),
        uninstall: () => removeManagedDirectory(paths.installDir),
        installed: () => existsSync(join(paths.installDir, MANAGED_MARKER)),
        installedBinding: () => claudeCodeBinding(paths),
      };
    }
    case "codex": {
      const paths = codexPaths(accountKey, home);
      return {
        clientName: serverName,
        activation: `Restart Codex, then use /${addressFeedbackCommand(accountKey)}.`,
        install: (input) => installCodex(input, paths, serverName),
        uninstall: () => uninstallCodex(paths, serverName),
        installed: () => codexInstalled(paths, serverName),
        installedBinding: () => codexBinding(paths, serverName),
      };
    }
    case "opencode": {
      const paths = openCodePaths(accountKey, home);
      return {
        clientName: serverName,
        activation: `Restart opencode, then use /${addressFeedbackCommand(accountKey)}.`,
        install: (input) => installOpenCode(input, paths, serverName),
        uninstall: () => uninstallOpenCode(paths, serverName),
        installed: () => jsonMcpEntryInstalled(paths.configFile, "mcp", serverName),
        installedBinding: () => jsonEntryBinding(paths.configFile, "mcp", serverName),
      };
    }
    case "cursor": {
      const paths = cursorPaths(accountKey, home);
      return {
        clientName: serverName,
        activation: `Reload the Cursor window, then enable “${serverName}” under Settings → MCP.`,
        install: (input) => installCursor(input, paths, serverName),
        uninstall: () => uninstallCursor(paths, serverName),
        installed: () => jsonMcpEntryInstalled(paths.configFile, "mcpServers", serverName),
        installedBinding: () => jsonEntryBinding(paths.configFile, "mcpServers", serverName),
      };
    }
  }
}
