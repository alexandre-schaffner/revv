import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { type AcpAgentId, getAgentCapabilities } from "@revv/shared";
import { serverEnv } from "../../config";
import { CLI_CACHE_TTL_MS } from "../../constants";

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
//        • Codex  — `@zed-industries/codex-acp` reads `~/.codex/auth.json`
//          (honoring `CODEX_HOME`). CLI *or* Codex desktop app login counts.
//        • Claude — `claude-agent-acp` runs on the Claude Agent SDK; an
//          `ANTHROPIC_API_KEY`, `~/.claude/.credentials.json`, or the macOS
//          Keychain login counts.
//      opencode (own binary) and Cursor (`cursor-agent-acp` shells out to the
//      `cursor-agent` CLI) are excluded — they genuinely need their binary.
//   3. `which <tool>` resolved against the user's *login-shell* PATH — not the
//      process PATH. A server launched by launchd / a GUI inherits a sanitized
//      PATH that omits where CLIs actually live (nvm, Homebrew on Apple Silicon,
//      npm global prefixes, app-managed bin dirs). Probing the login shell makes
//      detection match what the user sees in a terminal. Falls back to the
//      process PATH when there's no usable login shell (e.g. Windows).
//
// The (expensive) login-shell PATH lookup is resolved once and cached with a
// short TTL (see CLI_CACHE_TTL_MS); `which` against that PATH is a cheap
// filesystem probe.

type CliAgent = "opencode" | "claude" | "codex";

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
 * Ask the user's login shell for its PATH. Returns `null` on Windows, when no
 * `$SHELL` is set, or if the probe fails — callers fall back to the process
 * PATH. fish stores `$PATH` as a list, so it needs `string join`; POSIX shells
 * (bash/zsh) get `printf`. `command -v` is intentionally avoided here so one
 * probe yields the whole PATH rather than one binary.
 */
function loginShellPath(): string | null {
  const shell = process.env.SHELL;
  if (!shell || platform() === "win32") return null;
  const isFish = /(^|\/)fish$/.test(shell);
  const inner = isFish ? "string join : $PATH" : 'printf %s "$PATH"';
  try {
    // `-lic`: login + interactive so PATH set in either profile or rc is sourced.
    const out = execSync(`${shell} -lic '${inner}'`, {
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

/** Codex's config/auth dir — `$CODEX_HOME`, else `~/.codex`. */
function codexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".codex");
}

/** The user has logged in to Codex (via CLI or the desktop app) if its auth file exists. */
function codexLoggedIn(): boolean {
  return existsSync(join(codexHome(), "auth.json"));
}

/**
 * Whether Claude Code is authenticated. The `claude-agent-acp` adapter runs on
 * the Claude Agent SDK (not the `claude` binary), so a logged-in user is usable
 * without the CLI on PATH. The SDK accepts, in order: an `ANTHROPIC_API_KEY`
 * env var; the OAuth creds Claude Code writes to `~/.claude/.credentials.json`
 * (Linux/other); or, on macOS, the same creds stored in the login Keychain.
 */
function claudeLoggedIn(): boolean {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return true;
  if (existsSync(join(homedir(), ".claude", ".credentials.json"))) return true;
  if (platform() === "darwin") {
    try {
      // Existence probe only (no `-w`): returns attributes, doesn't print the secret.
      execSync('security find-generic-password -s "Claude Code-credentials"', {
        timeout: 3000,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Absolute path of `command` if found on the user's login-shell PATH, else null.
 */
function resolveCommandPath(command: string): string | null {
  const isWin = platform() === "win32";
  try {
    const out = execSync(`${isWin ? "where" : "which"} ${command}`, {
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
 * Absolute path to the CLI binary if we have one, else the bare name so
 * Bun.spawn falls back to PATH resolution. Callers should pass the result
 * directly as argv[0] of a spawn call.
 */
export function resolveCliBin(agent: CliAgent): string {
  return pinnedBin(agent) || resolveCommandPath(agent) || agent;
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

// ── Dynamic model listing ─────────────────────────────────────────────────────

export type CliModelOption = { label: string; value: string };

/**
 * List models available to the selected ACP agent. Agents with a static
 * catalog (claude-code, codex, cursor) return it straight from the shared
 * registry; opencode is the only dynamic catalog, probed by running
 * `opencode models --verbose` and parsing the output.
 */
export async function listCliModels(agent: AcpAgentId): Promise<CliModelOption[]> {
  // Static catalogs come straight from the shared ACP registry — the single
  // source of truth — so there's no second copy to keep in sync. Only opencode
  // has a dynamic catalog that must be probed at runtime.
  const caps = getAgentCapabilities(agent);
  if (caps.models !== "dynamic") {
    return caps.models.map((m) => ({ label: m.label, value: m.value }));
  }

  // opencode: run `opencode models --verbose` and parse interleaved output
  // Format: line with "provider/id", then JSON blob with model metadata, repeated
  try {
    const proc = Bun.spawn([resolveCliBin("opencode"), "models", "--verbose"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const models: CliModelOption[] = [];
    const lines = text.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]?.trim();
      if (!line) {
        i++;
        continue;
      }

      // Check if this line looks like a model ID (e.g. "provider/model-id")
      if (!line.startsWith("{") && line.includes("/")) {
        const modelId = line;
        // Next non-empty content should be a JSON blob — collect until balanced braces
        let jsonStr = "";
        let depth = 0;
        i++;
        while (i < lines.length) {
          const jsonLine = lines[i] ?? "";
          jsonStr += `${jsonLine}\n`;
          for (const ch of jsonLine) {
            if (ch === "{") depth++;
            else if (ch === "}") depth--;
          }
          i++;
          if (depth === 0 && jsonStr.trim().startsWith("{")) break;
        }
        try {
          const meta = JSON.parse(jsonStr.trim()) as { name?: string; providerID?: string };
          const label = meta.name ?? modelId;
          models.push({ label, value: modelId });
        } catch {
          models.push({ label: modelId, value: modelId });
        }
      } else {
        i++;
      }
    }
    return models;
  } catch {
    // Fallback: empty list (frontend will show empty state)
    return [];
  }
}
