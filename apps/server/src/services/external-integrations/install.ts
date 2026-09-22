// ── External integration install mechanics ──────────────────────────────────
//
// Filesystem operations that place Revv's stdio MCP bridge and credential
// where each coding agent can pick them up:
//
//   - claude-code: a user-scoped plugin directory under `~/.claude/skills`
//                  with its own `.mcp.json` and workflow skill.
//   - codex:       a managed `[mcp_servers.revv]` block in `config.toml` plus
//                  a `/revv-address-feedback` custom prompt.
//   - opencode:    an `mcp.revv` entry in `opencode.json` plus a global
//                  `/revv-address-feedback` command.
//   - cursor:      an `mcpServers.revv` entry in `~/.cursor/mcp.json`.
//
// Every install is convergent (reconnect yields the same end state with a
// rotated credential) and refuses to replace files it does not own. Paths are
// derived from an explicit home directory so tests run inside temp dirs.

import { randomUUID } from "node:crypto";
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
  readonly apiUrl: string;
  readonly integrationsDirectory: string;
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
  // `mode` only applies when the file is created; existing files keep theirs.
  writeFileSync(file, content, { mode: 0o600 });
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

export function claudeCodePaths(home: string = homedir()): ClaudeCodePaths {
  return { installDir: join(home, ".claude", "skills", "revv") };
}

function installClaudeCode(input: BridgeInstallInput, paths: ClaudeCodePaths): void {
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
            REVV_API_URL: input.apiUrl,
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

export function codexPaths(home: string = homedir()): CodexPaths {
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  return {
    installDir: join(home, ".revv", "codex"),
    configFile: join(codexHome, "config.toml"),
    promptFile: join(codexHome, "prompts", "revv-address-feedback.md"),
  };
}

const CODEX_BLOCK_BEGIN = "# >>> revv managed >>>";
const CODEX_BLOCK_END = "# <<< revv managed <<<";
const CODEX_UNMANAGED_SECTION = /^\s*\[mcp_servers\.revv(?:\.|\])/m;

function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderCodexManagedBlock(input: BridgeInstallInput, installDir: string): string {
  return [
    CODEX_BLOCK_BEGIN,
    "[mcp_servers.revv]",
    `command = ${tomlBasicString(input.runtimeExecutable)}`,
    `args = ["run", ${tomlBasicString(bridgeFile(installDir))}]`,
    "",
    "[mcp_servers.revv.env]",
    `REVV_INTEGRATION_TOKEN = ${tomlBasicString(input.token)}`,
    `REVV_API_URL = ${tomlBasicString(input.apiUrl)}`,
    CODEX_BLOCK_END,
  ].join("\n");
}

function managedBlockSpan(content: string): { begin: number; end: number } | null {
  const begin = content.indexOf(CODEX_BLOCK_BEGIN);
  const end = content.indexOf(CODEX_BLOCK_END);
  if (begin === -1 && end === -1) return null;
  if (begin === -1 || end === -1 || end <= begin) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      "The Revv-managed section of the Codex config.toml is damaged. Remove the partial revv markers and reconnect.",
    );
  }
  return { begin, end: end + CODEX_BLOCK_END.length };
}

function mergeCodexConfig(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === "") return `${block}\n`;
  const span = managedBlockSpan(existing);
  if (span) {
    const before = existing.slice(0, span.begin).replace(/\s+$/, "");
    const after = existing.slice(span.end).replace(/^\s+/, "");
    return `${[before, block, after].filter(Boolean).join("\n\n")}\n`;
  }
  if (CODEX_UNMANAGED_SECTION.test(existing)) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      "The Codex config.toml already has an [mcp_servers.revv] section that Revv did not create. Remove it and reconnect.",
    );
  }
  return `${existing.replace(/\s+$/, "")}\n\n${block}\n`;
}

function stripCodexManagedBlock(existing: string): string {
  const span = managedBlockSpan(existing);
  if (!span) return existing;
  const before = existing.slice(0, span.begin).replace(/\s+$/, "");
  const after = existing.slice(span.end).replace(/^\s+/, "");
  const merged = [before, after].filter(Boolean).join("\n\n");
  return merged === "" ? "" : `${merged}\n`;
}

function installCodex(input: BridgeInstallInput, paths: CodexPaths): void {
  writeManagedDirectory(paths.installDir, (staged) => {
    stageBridge(staged, input.integrationsDirectory);
  });
  writePrivateTextFile(
    paths.configFile,
    mergeCodexConfig(
      readTextIfExists(paths.configFile),
      renderCodexManagedBlock(input, paths.installDir),
    ),
  );
  // Codex custom prompts are plain markdown; it has no front-matter contract.
  writeManagedGuide(paths.promptFile, renderGuide(input.integrationsDirectory, []));
}

function uninstallCodex(paths: CodexPaths): void {
  const existing = readTextIfExists(paths.configFile);
  if (existing !== null) {
    writePrivateTextFile(paths.configFile, stripCodexManagedBlock(existing));
  }
  removeManagedGuide(paths.promptFile);
  removeManagedDirectory(paths.installDir);
}

function codexInstalled(paths: CodexPaths): boolean {
  const existing = readTextIfExists(paths.configFile);
  return existing?.includes(CODEX_BLOCK_BEGIN) ?? false;
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

/** Upsert the Revv server under `config[section].revv`, refusing foreign rows. */
function upsertJsonMcpEntry(file: string, section: string, entry: Record<string, unknown>): void {
  const config = readJsonConfig(file);
  const servers = nestedRecord(config, section);
  if (servers.revv !== undefined && !isRevvManagedEntry(servers.revv)) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `${file} already has a ${section}.revv entry that Revv did not create. Remove it and reconnect.`,
    );
  }
  servers.revv = entry;
  writePrivateTextFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

function removeJsonMcpEntry(file: string, section: string): void {
  const existing = readTextIfExists(file);
  if (existing === null || existing.trim() === "") return;
  const config = readJsonConfig(file);
  const servers = config[section];
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return;
  const entry = (servers as Record<string, unknown>).revv;
  if (entry === undefined) return;
  if (!isRevvManagedEntry(entry)) {
    throw externalIntegrationError(
      "INSTALL_FAILED",
      `Refusing to remove the non-Revv ${section}.revv entry in ${file}.`,
    );
  }
  delete (servers as Record<string, unknown>).revv;
  writePrivateTextFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

function jsonMcpEntryInstalled(file: string, section: string): boolean {
  try {
    const servers = readJsonConfig(file)[section];
    return (
      servers !== null &&
      typeof servers === "object" &&
      !Array.isArray(servers) &&
      isRevvManagedEntry((servers as Record<string, unknown>).revv)
    );
  } catch {
    return false;
  }
}

// ── OpenCode (opencode.json mcp entry + global command) ─────────────────────

export interface OpenCodePaths {
  readonly installDir: string;
  readonly configFile: string;
  readonly commandFile: string;
}

export function openCodePaths(home: string = homedir()): OpenCodePaths {
  const configDir = join(home, ".config", "opencode");
  // Prefer the plain-JSON file; fall back to an existing JSONC file so the
  // entry lands wherever the user actually keeps their global config.
  const jsonFile = join(configDir, "opencode.json");
  const jsoncFile = join(configDir, "opencode.jsonc");
  return {
    installDir: join(home, ".revv", "opencode"),
    configFile: existsSync(jsonFile) || !existsSync(jsoncFile) ? jsonFile : jsoncFile,
    commandFile: join(configDir, "command", "revv-address-feedback.md"),
  };
}

function installOpenCode(input: BridgeInstallInput, paths: OpenCodePaths): void {
  writeManagedDirectory(paths.installDir, (staged) => {
    stageBridge(staged, input.integrationsDirectory);
  });
  upsertJsonMcpEntry(paths.configFile, "mcp", {
    type: "local",
    command: [input.runtimeExecutable, "run", bridgeFile(paths.installDir)],
    enabled: true,
    environment: {
      REVV_INTEGRATION_TOKEN: input.token,
      REVV_API_URL: input.apiUrl,
    },
  });
  writeManagedGuide(
    paths.commandFile,
    renderGuide(input.integrationsDirectory, [
      "description: Address Revv review feedback in the current checkout",
    ]),
  );
}

function uninstallOpenCode(paths: OpenCodePaths): void {
  removeJsonMcpEntry(paths.configFile, "mcp");
  removeManagedGuide(paths.commandFile);
  removeManagedDirectory(paths.installDir);
}

// ── Cursor (~/.cursor/mcp.json) ─────────────────────────────────────────────

export interface CursorPaths {
  readonly installDir: string;
  readonly configFile: string;
}

export function cursorPaths(home: string = homedir()): CursorPaths {
  return {
    installDir: join(home, ".revv", "cursor"),
    configFile: join(home, ".cursor", "mcp.json"),
  };
}

function installCursor(input: BridgeInstallInput, paths: CursorPaths): void {
  writeManagedDirectory(paths.installDir, (staged) => {
    stageBridge(staged, input.integrationsDirectory);
  });
  upsertJsonMcpEntry(paths.configFile, "mcpServers", {
    type: "stdio",
    command: input.runtimeExecutable,
    args: ["run", bridgeFile(paths.installDir)],
    env: {
      REVV_INTEGRATION_TOKEN: input.token,
      REVV_API_URL: input.apiUrl,
    },
  });
}

function uninstallCursor(paths: CursorPaths): void {
  removeJsonMcpEntry(paths.configFile, "mcpServers");
  removeManagedDirectory(paths.installDir);
}

// ── Provider registry ───────────────────────────────────────────────────────

export interface ExternalIntegrationInstaller {
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
  home: string = homedir(),
): ExternalIntegrationInstaller {
  switch (provider) {
    case "claude-code": {
      const paths = claudeCodePaths(home);
      return {
        locations: [paths.installDir],
        install: (input) => installClaudeCode(input, paths),
        uninstall: () => removeManagedDirectory(paths.installDir),
        installed: () => existsSync(join(paths.installDir, MANAGED_MARKER)),
      };
    }
    case "codex": {
      const paths = codexPaths(home);
      return {
        locations: [paths.configFile, paths.promptFile],
        install: (input) => installCodex(input, paths),
        uninstall: () => uninstallCodex(paths),
        installed: () => codexInstalled(paths),
      };
    }
    case "opencode": {
      const paths = openCodePaths(home);
      return {
        locations: [paths.configFile, paths.commandFile],
        install: (input) => installOpenCode(input, paths),
        uninstall: () => uninstallOpenCode(paths),
        installed: () => jsonMcpEntryInstalled(paths.configFile, "mcp"),
      };
    }
    case "cursor": {
      const paths = cursorPaths(home);
      return {
        locations: [paths.configFile],
        install: (input) => installCursor(input, paths),
        uninstall: () => uninstallCursor(paths),
        installed: () => jsonMcpEntryInstalled(paths.configFile, "mcpServers"),
      };
    }
  }
}
