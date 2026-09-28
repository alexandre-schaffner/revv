import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ACP_AGENT_IDS,
  type AcpAgentId,
  type AgentStatus,
  type AgentStatusReport,
  getAgentCapabilities,
} from "@revv/shared";
import { serverEnv } from "../../config";
import { CLI_CACHE_TTL_MS } from "../../constants";
import { debug, logError } from "../../logger";
import { resolveClaudeConfigDir } from "../acp/claude-config";

// ── CLI agent detection ──────────────────────────────────────────────────────
//
// Resolution chain, in order:
//
//   1. REVV_CLAUDE_BIN / REVV_OPENCODE_BIN / REVV_CODEX_BIN — absolute paths
//      baked into the LaunchAgent at install time by `write_launch_agent_plist`
//      in scripts/lib/common.sh (which runs `command -v <tool>` with the
//      installer's shell PATH). Survives a restricted LaunchAgent PATH.
//   2. Auth-only fallback for the npx-adapter agents whose adapter authenticates
//      from a local store instead of shelling out to the named CLI:
//        • Codex  — `@agentclientprotocol/codex-acp` reads `~/.codex/auth.json`
//          (honoring `CODEX_HOME`). CLI *or* Codex desktop app login counts.
//        • Claude — `claude-agent-acp` runs on the Claude Agent SDK; an
//          `ANTHROPIC_API_KEY`, `~/.claude/.credentials.json`, or the macOS
//          Keychain login counts.
//      opencode (own binary) and Cursor (`cursor-agent-acp` shells out to the
//      `cursor-agent` CLI) are excluded — they genuinely need their binary.
//   3. The Codex desktop app bundle on macOS. The bundled CLI shares the
//      desktop app's ChatGPT login, but the app cannot always create its PATH
//      alias (for example, when it lacks permission to write the shell setup).
//   4. `which <tool>` resolved against the user's *login-shell* PATH — not the
//      process PATH. A server launched by launchd / a GUI inherits a sanitized
//      PATH that omits where CLIs actually live (nvm, Homebrew on Apple Silicon,
//      npm global prefixes, app-managed bin dirs). Probing the login shell makes
//      detection match what the user sees in a terminal. Falls back to the
//      process PATH when there's no usable login shell.
//
// The (expensive) login-shell PATH lookup is resolved once and cached with a
// short TTL (see CLI_CACHE_TTL_MS); `which` against that PATH is a cheap
// filesystem probe.

type CliAgent = "opencode" | "claude" | "codex";
type AgentAuthStatus = Pick<
  AgentStatus,
  "authed" | "verified" | "authSource" | "authLabel" | "authWarning"
>;

const CODEX_DESKTOP_CLI_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  join(homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
] as const;

/**
 * Resolve the Codex CLI bundled with the macOS desktop app. This is a fallback
 * only: an explicit Revv pin or a user-managed PATH installation takes
 * precedence. Keeping the probe here means status checks and embedded login
 * launch the same executable that owns the desktop app's session.
 */
export function resolveDesktopCodexBin(
  candidates: readonly string[] = CODEX_DESKTOP_CLI_CANDIDATES,
  isExecutable: (path: string) => boolean = (path) => {
    try {
      const stat = statSync(path);
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  },
): string | null {
  return candidates.find(isExecutable) ?? null;
}

let cachedPath: { value: string; expiresAt: number } | null = null;

/**
 * The directories the user's interactive login shell would search, merged onto
 * the process PATH. This is the PATH detection and ACP launches should use —
 * see the resolution-chain note above for why the inherited process PATH is not
 * enough. Result is cached; `invalidateCliAgentCache` drops it.
 */
export function resolveUserPath(): string {
  if (cachedPath && Date.now() < cachedPath.expiresAt) return cachedPath.value;
  const base = process.env.PATH ?? "";
  const login = loginShellPath();
  const value = login
    ? Array.from(new Set([...base.split(":"), ...login.split(":")].filter(Boolean))).join(":")
    : base;
  cachedPath = { value, expiresAt: Date.now() + CLI_CACHE_TTL_MS };
  return value;
}

/**
 * Ask the user's login shell for its PATH. Returns `null` when no `$SHELL` is
 * set or if the probe fails — callers fall back to the process PATH. fish
 * stores `$PATH` as a list, so it needs `string join`; POSIX shells (bash/zsh)
 * get `printf`. `command -v` is intentionally avoided here so one probe yields
 * the whole PATH rather than one binary.
 */
function loginShellPath(): string | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  const isFish = /(^|\/)fish$/.test(shell);
  const inner = isFish ? "string join : $PATH" : 'printf %s "$PATH"';
  try {
    // `-lic`: login + interactive so PATH set in either profile or rc is sourced.
    // `execFileSync` (argv form) — never interpolate `$SHELL` into a shell string;
    // a `$SHELL` with spaces or metacharacters would otherwise mis-parse.
    const out = execFileSync(shell, ["-lic", inner], {
      encoding: "utf-8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function pinnedBin(agent: CliAgent): string {
  const pinned =
    agent === "claude"
      ? serverEnv.claudeBin
      : agent === "codex"
        ? serverEnv.codexBin
        : serverEnv.opencodeBin;
  return pinned && existsSync(pinned) ? pinned : "";
}

function statusCommandEnv(omit: readonly string[] = []): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: resolveUserPath(),
  };
  for (const key of omit) delete env[key];
  return env;
}

function commandStatusOk(
  command: string,
  args: readonly string[],
  env = statusCommandEnv(),
): boolean {
  try {
    execFileSync(command, args, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    return true;
  } catch {
    return false;
  }
}

/** Codex's config/auth dir — `$CODEX_HOME`, else `~/.codex`. */
function codexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".codex");
}

/** The user has logged in to Codex (via CLI or the desktop app) if its auth file exists. */
function codexLoggedIn(): boolean {
  return existsSync(join(codexHome(), "auth.json"));
}

function codexLoginVerified(): boolean {
  return commandStatusOk(resolveCliBin("codex"), ["login", "status"]);
}

function codexAuthStatus(): AgentAuthStatus {
  const hasLogin = codexLoggedIn();
  const hasApiKey = !!process.env.OPENAI_API_KEY?.trim();
  const verified = codexLoginVerified();
  if (hasLogin && hasApiKey) {
    return {
      authed: true,
      verified,
      authSource: "local-credentials",
      authLabel: verified ? "Codex login + OpenAI API key" : "Codex credentials configured",
      authWarning:
        "Both Codex login and OPENAI_API_KEY are present; provider precedence is owned by Codex.",
    };
  }
  if (hasLogin) {
    if (!verified) {
      return {
        authed: false,
        verified: false,
        authSource: "local-credentials",
        authLabel: "Codex sign-in expired",
        authWarning:
          "Codex credential artifacts exist, but Codex login status does not confirm an active session. Sign in again with Codex.",
      };
    }
    return {
      authed: true,
      verified: true,
      authSource: "local-credentials",
      authLabel: "Codex login",
      authWarning: null,
    };
  }
  if (hasApiKey) {
    return {
      authed: true,
      verified,
      authSource: "api-key",
      authLabel: verified ? "OpenAI API key verified" : "OpenAI API key configured",
      authWarning: verified
        ? null
        : "Revv found OPENAI_API_KEY, but Codex login status did not verify it without starting a generation.",
    };
  }
  if (verified) {
    return {
      authed: true,
      verified: true,
      authSource: "local-credentials",
      authLabel: "Codex login",
      authWarning: null,
    };
  }
  return {
    authed: false,
    verified: false,
    authSource: "none",
    authLabel: "Not signed in",
    authWarning: null,
  };
}

/**
 * Whether Claude Code has subscription/OAuth credentials available. The
 * `claude-agent-acp` adapter runs on the Claude Agent SDK, so a logged-in user
 * is usable without the CLI on PATH. Subscription auth can come from a
 * long-lived OAuth token, the credentials file Claude Code writes, or the macOS
 * Keychain.
 *
 * This is a best-effort HINT only (used for "sign-in expired" vs "not signed
 * in" messaging) — the authoritative check is `claudeSubscriptionVerified`.
 * The credentials-file probe checks the isolated dir when isolation is on; the
 * Keychain existence probe does not — it always checks the default `Claude
 * Code-credentials` service, since an isolated dir's Keychain item uses a
 * different (unpublished) service name suffix (see `claude-config.ts`). A
 * false negative here just means slightly less precise wording, never a wrong
 * `authed` result.
 */
function detectClaudeSubscriptionAuthHint(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
  const claudeConfigDir = resolveClaudeConfigDir("claude-code") ?? join(homedir(), ".claude");
  if (existsSync(join(claudeConfigDir, ".credentials.json"))) return true;
  try {
    // Existence probe only (no `-w`): returns attributes, doesn't print the secret.
    execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
      timeout: 3000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Env for the `claude auth status` probe. Critically includes `CLAUDE_CONFIG_DIR`
 * when isolation is on (`resolveClaudeConfigDir`) — Claude Code's Keychain-backed
 * OAuth item is scoped per resolved config dir (see `claude-config.ts`), so a
 * probe run under the wrong dir reads the wrong (or no) Keychain item and
 * reports logged-out even when the isolated dir's own one-time login succeeded.
 */
export function claudeStatusCommandEnv(
  omit: readonly string[] = [],
): Record<string, string | undefined> {
  const env = statusCommandEnv(omit);
  const claudeConfigDir = resolveClaudeConfigDir("claude-code");
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  return env;
}

function claudeSubscriptionVerified(): boolean {
  try {
    const out = execFileSync(resolveCliBin("claude"), ["auth", "status", "--json"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: claudeStatusCommandEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]),
    }).trim();
    if (!out) return true;
    const parsed = JSON.parse(out) as { loggedIn?: unknown };
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Whether Claude Code subscription/OAuth auth is verified by Claude's own CLI
 * status command, in the SAME `CLAUDE_CONFIG_DIR` context the agent will
 * actually spawn with (see `claudeStatusCommandEnv`). Credential artifacts
 * alone are intentionally not enough: logout can leave files/keychain records
 * behind even though launches fail with "Authentication required".
 */
export function detectClaudeSubscriptionAuth(): boolean {
  return claudeSubscriptionVerified();
}

function claudeApiCredentialsConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
}

function claudeLoggedIn(): boolean {
  return claudeSubscriptionVerified() || claudeApiCredentialsConfigured();
}

function claudeAuthStatus(): AgentAuthStatus {
  const hasSubscriptionHint = detectClaudeSubscriptionAuthHint();
  const hasVerifiedSubscription = claudeSubscriptionVerified();
  const hasApiCredentials = claudeApiCredentialsConfigured();
  if (hasVerifiedSubscription) {
    return {
      authed: true,
      verified: true,
      authSource: "subscription",
      authLabel: hasApiCredentials
        ? "Claude subscription (API key ignored by Revv)"
        : "Claude subscription",
      authWarning: hasApiCredentials
        ? "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is also present. Revv strips it for Claude ACP so the subscription is used."
        : null,
    };
  }
  if (hasApiCredentials) {
    return {
      authed: true,
      verified: false,
      authSource: "api-key",
      authLabel: "Anthropic API key configured",
      authWarning: hasSubscriptionHint
        ? "Claude Code sign-in is not active. Revv will keep Anthropic API credentials instead of treating the stale Claude session as connected."
        : null,
    };
  }
  if (hasSubscriptionHint) {
    return {
      authed: false,
      verified: false,
      authSource: "subscription",
      authLabel: "Claude sign-in expired",
      authWarning:
        "Claude credential artifacts exist, but Claude reports authentication is required. Sign in again with Claude Code.",
    };
  }
  return {
    authed: false,
    verified: false,
    authSource: "none",
    authLabel: "Not signed in",
    authWarning: null,
  };
}

/**
 * Whether the user has logged in to Cursor's CLI. `cursor-agent` persists its
 * session token after `cursor-agent login`; an env-injected `CURSOR_API_KEY`
 * also counts. The on-disk location isn't part of Cursor's public contract, so
 * we probe the credential files seen across versions/platforms — XDG
 * (`~/.config/cursor-agent`, `~/.local/share/cursor-agent`) and the legacy
 * `~/.cursor` dir.
 *
 * NOTE: re-verify these paths against a real `cursor-agent` install — if Cursor
 * moves its credential file, only this allowlist needs updating. A miss here is
 * conservative (UI shows "Sign in" for an already-authed Cursor), never unsafe.
 */
function cursorLoggedIn(): boolean {
  if (process.env.CURSOR_API_KEY?.trim()) return true;
  const home = homedir();
  const candidates = [
    join(home, ".config", "cursor-agent", "credentials.json"),
    join(home, ".config", "cursor-agent", "auth.json"),
    join(home, ".local", "share", "cursor-agent", "credentials.json"),
    join(home, ".local", "share", "cursor-agent", "auth.json"),
    join(home, ".cursor", "credentials.json"),
    join(home, ".cursor", "auth.json"),
  ];
  return candidates.some((p) => existsSync(p));
}

function cursorLoginVerified(): boolean {
  return commandStatusOk(resolveCommandPath("cursor-agent") ?? "cursor-agent", ["status"]);
}

function cursorAuthStatus(): AgentAuthStatus {
  const verified = cursorLoginVerified();
  if (process.env.CURSOR_API_KEY?.trim()) {
    return {
      authed: true,
      verified,
      authSource: "api-key",
      authLabel: verified ? "Cursor API key verified" : "Cursor API key configured",
      authWarning: verified
        ? null
        : "Revv found CURSOR_API_KEY, but Cursor status did not verify it without starting a generation.",
    };
  }
  if (cursorLoggedIn()) {
    if (!verified) {
      return {
        authed: false,
        verified: false,
        authSource: "local-credentials",
        authLabel: "Cursor sign-in expired",
        authWarning:
          "Cursor credential artifacts exist, but Cursor status does not confirm an active session. Sign in again with Cursor.",
      };
    }
    return {
      authed: true,
      verified: true,
      authSource: "local-credentials",
      authLabel: "Cursor login",
      authWarning: null,
    };
  }
  if (verified) {
    return {
      authed: true,
      verified: true,
      authSource: "local-credentials",
      authLabel: "Cursor login",
      authWarning: null,
    };
  }
  return {
    authed: false,
    verified: false,
    authSource: "none",
    authLabel: "Not signed in",
    authWarning: null,
  };
}

function agentAuthStatus(agent: AcpAgentId): AgentAuthStatus {
  switch (agent) {
    case "opencode":
      return {
        authed: true,
        verified: true,
        authSource: "not-required",
        authLabel: "No sign-in required",
        authWarning: null,
      };
    case "claude-code":
      return claudeAuthStatus();
    case "codex":
      return codexAuthStatus();
    case "cursor":
      return cursorAuthStatus();
  }
}

/**
 * Whether the given registry agent is *authenticated* (logged in), independent
 * of whether its CLI is on PATH. Onboarding uses this to distinguish
 * installed-but-not-logged-in (show "Sign in") from ready-to-use (show
 * "Continue"). opencode needs no login — it's a local engine — so it always
 * reports authed.
 */
export function detectAgentAuth(agent: AcpAgentId): boolean {
  return agentAuthStatus(agent).authed;
}

/**
 * Absolute path of `command` if found on the user's login-shell PATH, else null.
 */
function resolveCommandPath(command: string): string | null {
  try {
    const out = execFileSync("which", [command], {
      encoding: "utf-8",
      timeout: 3000,
      env: { ...process.env, PATH: resolveUserPath() },
    }).trim();
    return out.length > 0 ? (out.split("\n")[0] ?? null) : null;
  } catch {
    return null;
  }
}

function isCliAgentAvailable(agent: CliAgent): boolean {
  if (pinnedBin(agent)) return true;
  // Agents whose ACP adapter is npx-based and authenticates from a local store
  // (rather than shelling out to the named CLI) are usable when logged in, even
  // with no binary on PATH. opencode is intentionally excluded: it launches via
  // its own `opencode` binary, so the binary is genuinely required.
  if (agent === "codex" && codexLoggedIn()) return true;
  if (agent === "claude" && claudeLoggedIn()) return true;
  return resolveCommandPath(agent) !== null;
}

/**
 * Directories where opencode's installers commonly place the binary. The
 * login-shell PATH probe (see {@link resolveUserPath}) usually finds it, but
 * package-manager installs (bun, official installer, Homebrew) can live in
 * directories that a launchd-spawned server doesn't inherit on its process
 * PATH and that the user's shell profile doesn't expose to non-interactive
 * probes. This fallback is the last resort before giving up.
 */
function opencodeFallbackBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".bun", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

function resolveOpencodeFallbackBin(): string | null {
  for (const dir of opencodeFallbackBinDirs()) {
    const candidate = join(dir, "opencode");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not present, or present but not executable (broken symlink,
      // half-finished install) — fall through to the next candidate dir.
    }
  }
  return null;
}

/**
 * Absolute path to the CLI binary if we have one, else the bare name so
 * Bun.spawn falls back to PATH resolution. Callers should pass the result
 * directly as argv[0] of a spawn call.
 */
export function resolveCliBin(agent: CliAgent): string {
  const resolved = pinnedBin(agent) || resolveCommandPath(agent);
  if (resolved) return resolved;
  if (agent === "opencode") {
    const fallback = resolveOpencodeFallbackBin();
    if (fallback) return fallback;
  }
  if (agent === "codex") {
    const fallback = resolveDesktopCodexBin();
    if (fallback) return fallback;
  }
  return agent;
}

/**
 * Whether `command` resolves on the user's login-shell PATH. Used by onboarding
 * to detect agent CLIs that have no `REVV_*_BIN` pin (e.g. Cursor's
 * `cursor-agent`), where the pinned `checkCliAvailability` path doesn't apply.
 */
export function isCommandOnPath(command: string): boolean {
  return resolveCommandPath(command) !== null;
}

export function checkCliAvailability(agent: CliAgent): boolean {
  return isCliAgentAvailable(agent);
}

/**
 * Drop the cached login-shell PATH so the next availability check re-probes the
 * shell and filesystem. Called by the onboarding install flow after a
 * successful install — without this the TTL would mask the newly-present binary
 * until the cache naturally expired.
 */
export function invalidateCliAgentCache(): void {
  cachedPath = null;
}

// ── Onboarding agent status ────────────────────────────────────────────────────
//
// The single detection surface the onboarding agent step consumes — both
// "installed?" and "logged in?" for every registry agent, plus the per-agent
// login command and whether this host can drive an embedded PTY login. Keeping
// it here (the canonical CLI-detection module) means the UI hits one endpoint
// and the install/login services don't each own half of the detection logic.

/**
 * Registry id → the CLI binary whose presence means the agent is set up
 * locally. The SDK/auth-store agents (claude, codex) honor their `REVV_*_BIN`
 * pins via `checkCliAvailability`; Cursor's `cursor-agent` has no pin, so it's a
 * bare PATH probe. Adding a registry agent surfaces a type error here until its
 * detection is wired — a deliberate compile-time nudge.
 */
export const ACP_CLI_NAME: Record<AcpAgentId, "opencode" | "claude" | "codex" | "cursor-agent"> = {
  "claude-code": "claude",
  opencode: "opencode",
  codex: "codex",
  cursor: "cursor-agent",
};

/**
 * Per-agent interactive login command. `null` means the agent needs no login
 * (opencode is a local engine). Mirrors the `Record<AcpAgentId, …>` shape used
 * across the registry so adding an ACP agent forces a decision here.
 *
 * Each is a dedicated, exit-after-auth login subcommand (verified against the
 * vendors' published CLI docs + the installed binaries' `--help`), so the
 * login flow's "spawn → wait for exit → re-check auth" model holds:
 *   - claude-code: `claude auth login --claudeai`  (`/login` is the in-REPL
 *     slash command, NOT a CLI subcommand). The explicit `--claudeai` matters:
 *     Revv's Claude path is meant to use the user's Claude subscription, while
 *     `--console` is the API-billing path.
 *   - codex:       `codex login`.
 *   - cursor:      `cursor-agent login` (the docs alias the binary as `agent`,
 *     but the installed binary — and our `ACP_CLI_NAME.cursor` key — is
 *     `cursor-agent`).
 * Each CLI opens the user's browser itself; the login UI's auth-url scan only
 * powers a fallback link. Surfaced in {@link AgentStatus.loginCommand} as a
 * manual copy-paste hint alongside the embedded PTY login.
 */
export const ACP_LOGIN_COMMAND: Record<AcpAgentId, readonly string[] | null> = {
  opencode: null,
  "claude-code": ["claude", "auth", "login", "--claudeai"],
  codex: ["codex", "login"],
  cursor: ["cursor-agent", "login"],
};

/**
 * Resolve the login command's argv[0] through the same pinned-bin / login-shell
 * PATH chain used by runtime launches. This keeps the embedded login terminal
 * working in packaged app launches where `claude`/`codex` are not on the
 * sanitized process PATH.
 */
export function resolveAgentLoginCommand(agent: AcpAgentId): readonly string[] | null {
  const argv = ACP_LOGIN_COMMAND[agent];
  if (!argv) return null;
  const [command, ...args] = argv;
  if (!command) return argv;

  const cli = ACP_CLI_NAME[agent];
  const resolved =
    cli === "cursor-agent" ? (resolveCommandPath(cli) ?? command) : resolveCliBin(cli);
  return [resolved, ...args];
}

/** Whether the given registry agent's CLI is present (or otherwise usable). */
export function detectAgentCli(agent: AcpAgentId): boolean {
  const cli = ACP_CLI_NAME[agent];
  return cli === "cursor-agent" ? isCommandOnPath(cli) : checkCliAvailability(cli);
}

/**
 * One-shot onboarding detection snapshot for every registry agent: installed +
 * authed + the manual login command, plus whether this host supports the
 * embedded PTY login (always true on macOS). The single source of truth the
 * agent step's adaptive CTA reads.
 */
export function detectAgentStatus(): AgentStatusReport {
  const agents = Object.fromEntries(
    ACP_AGENT_IDS.map((id) => {
      const cmd = ACP_LOGIN_COMMAND[id];
      const auth = agentAuthStatus(id);
      return [
        id,
        {
          installed: detectAgentCli(id),
          ...auth,
          loginCommand: cmd ? cmd.join(" ") : null,
        } satisfies AgentStatus,
      ];
    }),
  ) as Record<AcpAgentId, AgentStatus>;
  // Revv is macOS-only, so the embedded PTY login is always available.
  return { embeddedLoginSupported: true, agents };
}

// ── Dynamic model listing ─────────────────────────────────────────────────────

export type CliModelOption = { label: string; value: string };

/**
 * Parse opencode 2's `GET /api/model` response (via `opencode api`) into picker
 * options. Values are `provider/model` — the same ids opencode's ACP `model`
 * config option takes. Disabled models are dropped, and rows are ordered by
 * value so each provider's models stay together (the API orders by release).
 */
export function parseOpencodeModelList(text: string): CliModelOption[] {
  const parsed: unknown = JSON.parse(text);
  const data =
    parsed && typeof parsed === "object" && "data" in parsed && Array.isArray(parsed.data)
      ? (parsed.data as unknown[])
      : [];
  const models: CliModelOption[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const { id, providerID, name, enabled } = row as Record<string, unknown>;
    if (typeof id !== "string" || typeof providerID !== "string" || enabled === false) continue;
    const value = `${providerID}/${id}`;
    models.push({ label: typeof name === "string" && name ? name : value, value });
  }
  return models.sort((a, b) => a.value.localeCompare(b.value));
}

// opencode 2 serves its catalog from a shared background service, which
// `opencode api` starts on demand. A service that is still starting answers
// with an empty snapshot (the catalog "may precede initial plugin settlement"),
// so an empty list is retried briefly before it is believed. The CLI itself
// waits two minutes for a service that won't start; cap each call well below.
const OPENCODE_MODEL_LIST_ATTEMPTS = 10;
const OPENCODE_MODEL_LIST_RETRY_MS = 500;
const OPENCODE_MODEL_LIST_TIMEOUT_MS = 20_000;

/**
 * List models available to the selected ACP agent. Agents with a static
 * catalog (claude-code, codex, cursor) return it straight from the shared
 * registry; opencode is the only dynamic catalog, read from its server API
 * with `opencode api GET /api/model`.
 */
export async function listCliModels(agent: AcpAgentId): Promise<CliModelOption[]> {
  // Static catalogs come straight from the shared ACP registry — the single
  // source of truth — so there's no second copy to keep in sync. Only opencode
  // has a dynamic catalog that must be probed at runtime.
  const caps = getAgentCapabilities(agent);
  if (caps.models !== "dynamic") {
    return caps.models.map((m) => ({ label: m.label, value: m.value }));
  }

  const opencodeBin = resolveCliBin("opencode");
  debug("listCliModels", "opencode binary:", opencodeBin);
  try {
    for (let attempt = 1; attempt <= OPENCODE_MODEL_LIST_ATTEMPTS; attempt++) {
      const proc = Bun.spawn([opencodeBin, "api", "GET", "/api/model"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: OPENCODE_MODEL_LIST_TIMEOUT_MS,
        // Inherit the login-shell PATH so the spawn can resolve a bare binary
        // name even when the server process inherits a sanitized PATH.
        env: { ...process.env, PATH: resolveUserPath() },
      });
      const [text, stderrText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;

      if (proc.exitCode !== 0) {
        logError(
          "listCliModels",
          `opencode api GET /api/model exited ${proc.exitCode ?? "with signal"}`,
          stderrText.slice(0, 500),
        );
        return [];
      }

      const models = parseOpencodeModelList(text);
      if (models.length > 0) return models;
      if (attempt < OPENCODE_MODEL_LIST_ATTEMPTS) await Bun.sleep(OPENCODE_MODEL_LIST_RETRY_MS);
    }
    logError("listCliModels", "opencode reported no models");
    return [];
  } catch (e) {
    logError(
      "listCliModels",
      "failed to list opencode models",
      e instanceof Error ? e.message : String(e),
    );
    // Fallback: empty list (frontend will show empty state)
    return [];
  }
}
