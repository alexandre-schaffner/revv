import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { clampThinkingEffort, type ThinkingEffort } from "@revv/shared";
import { serverEnv } from "../../../config";
import { HOST_PROBE_TTL_MS, hostEnv, resolveCommandPath } from "../host";
import { ensureClaudeConfigDir, resolveClaudeConfigDir } from "./claude-config";
import { staticModels } from "./static-models";
import {
  type AgentAdapter,
  type AgentAuthStatus,
  type AgentProcessPurpose,
  firstAuthMethod,
  NOT_SIGNED_IN,
} from "./types";

const execFileAsync = promisify(execFile);

// Revv tier → `CLAUDE_CODE_EFFORT_LEVEL`. Effort controls adaptive reasoning on
// every model Revv offers (`MAX_THINKING_TOKENS` only applies to a fixed
// budget). `ultrathink` is a prompt keyword, not a level, so a stale persisted
// value lands on the deepest real tier.
const CLAUDE_EFFORT_LEVEL: Record<ThinkingEffort, string> = {
  ultra: "max",
  low: "low",
  medium: "medium",
  high: "high",
  "extra-high": "xhigh",
  max: "max",
  ultrathink: "max",
};

function bin(): string | null {
  const pinned = serverEnv.claudeBin;
  return (pinned && existsSync(pinned) ? pinned : null) ?? resolveCommandPath("claude");
}

function apiCredentialsConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
}

let subscriptionProbe: { value: boolean; expiresAt: number } | null = null;

/**
 * Claude's own `auth status`, run in the config dir the agent spawns with
 * (the Keychain item is scoped per dir). Credential artifacts alone are not
 * enough: logout can leave files and Keychain records behind while launches
 * fail with "Authentication required".
 */
function subscriptionStatusCommand() {
  const env = claudeProcessEnv(hostEnv(), "status", { subscriptionVerified: false });
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return { file: bin() ?? "claude", args: ["auth", "status", "--json"], env };
}

function recordSubscription(out: string | null): boolean {
  let value = false;
  try {
    const trimmed = out?.trim() ?? null;
    value =
      trimmed !== null &&
      (!trimmed || (JSON.parse(trimmed) as { loggedIn?: unknown }).loggedIn === true);
  } catch {
    value = false;
  }
  subscriptionProbe = { value, expiresAt: Date.now() + HOST_PROBE_TTL_MS };
  return value;
}

async function probeSubscription(): Promise<boolean> {
  const { file, args, env } = subscriptionStatusCommand();
  try {
    const pending = execFileAsync(file, args, { encoding: "utf-8", timeout: 5000, env });
    pending.child.stdin?.end();
    return recordSubscription((await pending).stdout);
  } catch {
    return recordSubscription(null);
  }
}

/**
 * The last probe while it is fresh. `processEnv` and `hasCredentialsWithoutCli`
 * answer synchronously (the spawn env is built synchronously, and "installed"
 * is read by synchronous callers), so a stale or cold cache probes here with
 * `execFileSync`; `authStatus` refreshes the cache without blocking.
 */
function subscriptionVerifiedCached(): boolean {
  if (subscriptionProbe && Date.now() < subscriptionProbe.expiresAt) return subscriptionProbe.value;
  const { file, args, env } = subscriptionStatusCommand();
  try {
    return recordSubscription(
      execFileSync(file, args, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        env,
      }),
    );
  } catch {
    return recordSubscription(null);
  }
}

export function forgetClaudeAuthProbe(): void {
  subscriptionProbe = null;
}

/**
 * Best-effort hint that subscription credentials exist, for "sign-in expired"
 * vs "not signed in" wording only. The Keychain probe checks the default
 * service name: an isolated dir's item has an unpublished suffix, so a miss
 * here only makes the wording less precise.
 */
async function subscriptionHint(): Promise<boolean> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
  const dir = resolveClaudeConfigDir() ?? join(homedir(), ".claude");
  if (existsSync(join(dir, ".credentials.json"))) return true;
  try {
    // Existence probe only (no `-w`): it doesn't print the secret.
    const pending = execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      { timeout: 3000 },
    );
    pending.child.stdin?.end();
    await pending;
    return true;
  } catch {
    return false;
  }
}

async function authStatus(): Promise<AgentAuthStatus> {
  const verified = await probeSubscription();
  const apiCredentials = apiCredentialsConfigured();
  if (verified) {
    return {
      authed: true,
      verified: true,
      authSource: "subscription",
      authLabel: apiCredentials
        ? "Claude subscription (API key ignored by Revv)"
        : "Claude subscription",
      authWarning: apiCredentials
        ? "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is also present. Revv strips it for Claude ACP so the subscription is used."
        : null,
    };
  }
  const hint = await subscriptionHint();
  if (apiCredentials) {
    return {
      authed: true,
      verified: false,
      authSource: "api-key",
      authLabel: "Anthropic API key configured",
      authWarning: hint
        ? "Claude Code sign-in is not active. Revv will keep Anthropic API credentials instead of treating the stale Claude session as connected."
        : null,
    };
  }
  if (hint) {
    return {
      authed: false,
      verified: false,
      authSource: "subscription",
      authLabel: "Claude sign-in expired",
      authWarning:
        "Claude credential artifacts exist, but Claude reports authentication is required. Sign in again with Claude Code.",
    };
  }
  return NOT_SIGNED_IN;
}

/**
 * Claude's ACP adapter runs the Agent SDK, whose CLI exports its own spans.
 * Configure only traces: the local collector accepts OTLP/HTTP JSON and has no
 * logs/metrics endpoints. Explicit settings in `env` always win.
 */
function telemetryEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  if (!(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT)) return {};
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: env.CLAUDE_CODE_ENABLE_TELEMETRY ?? "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA ?? "1",
    OTEL_TRACES_EXPORTER: env.OTEL_TRACES_EXPORTER ?? "otlp",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL:
      env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/json",
    OTEL_TRACES_EXPORT_INTERVAL: env.OTEL_TRACES_EXPORT_INTERVAL ?? "1000",
    OTEL_SERVICE_NAME: env.OTEL_SERVICE_NAME ?? "revv-agent-claude-code",
  };
}

/**
 * The claude-code environment, with its probes passed in so it stays pure.
 * Every purpose gets the isolated config dir. The ACP subprocess also loses
 * `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` when the subscription is
 * verified: Claude Code documents that those take precedence over a valid
 * Pro/Max subscription and produce 401s.
 */
export function claudeProcessEnv(
  env: Readonly<Record<string, string>>,
  purpose: AgentProcessPurpose,
  probes: { readonly subscriptionVerified: boolean; readonly configDir?: string | undefined },
): Record<string, string> {
  const next = { ...env };
  if (probes.configDir) next.CLAUDE_CONFIG_DIR = probes.configDir;
  if (purpose !== "acp") return next;
  if (probes.subscriptionVerified) {
    delete next.ANTHROPIC_API_KEY;
    delete next.ANTHROPIC_AUTH_TOKEN;
  }
  return { ...next, ...telemetryEnv(next) };
}

export const claudeCodeAdapter: AgentAdapter = {
  route: ({ model, thinkingEffort }) => {
    const env: Record<string, string> = {};
    if (model) env.ANTHROPIC_MODEL = model;
    // Revv always runs at Claude Code's default 1M context.
    const tier = clampThinkingEffort("claude-code", thinkingEffort, model);
    if (tier) env.CLAUDE_CODE_EFFORT_LEVEL = CLAUDE_EFFORT_LEVEL[tier];
    return { env };
  },
  processEnv: (env, purpose) => {
    const configDir = resolveClaudeConfigDir();
    // Seed the dir before the agent or the login can touch it; a no-op once seeded.
    if (configDir && purpose !== "status") ensureClaudeConfigDir(configDir);
    return claudeProcessEnv(env, purpose, {
      subscriptionVerified: purpose === "acp" && subscriptionVerifiedCached(),
      configDir,
    });
  },
  resolveBin: bin,
  launchNeedsCli: false,
  // `claude-agent-acp` runs on the Agent SDK: a login is usable without the CLI.
  hasCredentialsWithoutCli: () => subscriptionVerifiedCached() || apiCredentialsConfigured(),
  authStatus,
  authMethod: firstAuthMethod,
  listModels: async () => staticModels("claude-code"),
};
