// ── ACP launch resolution (server) ───────────────────────────────────────────
//
// The ACP agent registry itself (id, label, command, args, capabilities) is the
// single source of truth in `@revv/shared` (`ACP_AGENTS`) so the web provider
// list / selectors and the server launch stay in sync — adding an agent is one
// entry there. This module holds the server-only concerns: the `REVV_ACP_AGENT`
// / `REVV_ACP_COMMAND` overrides, availability checks, and — since ACP has no
// model protocol — per-adapter injection of the selected model / thinking-effort
// / context-window at launch time (args for Codex/opencode, env for Claude Code).

import {
  type AcpAgentId,
  type ContextWindow,
  getAcpAgent,
  getAgentCapabilities,
  getAgentCredentials,
  isAcpAgentId,
  type ThinkingEffort,
} from "@revv/shared";
import { serverEnv } from "../../config";
import { detectClaudeSubscriptionAuth, isCommandOnPath } from "../providers/cli-agent";

export interface AcpLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Extra env vars merged over `process.env` when spawning (Claude Code model/effort/context). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface AcpProcessLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The Revv-side selections we try to push into the agent at launch. ACP exposes
 * none of these over the wire, so each adapter gets them however it accepts them
 * (or not at all — see `cursor`). Everything is optional; an absent field leaves
 * the agent on its own default.
 */
export interface AcpLaunchConfig {
  readonly model?: string | undefined;
  readonly thinkingEffort?: ThinkingEffort | undefined;
  readonly contextWindow?: ContextWindow | undefined;
}

export interface AcpProcessEnvOptions {
  /**
   * Test seam for the Claude subscription status probe. Production leaves it
   * undefined so subscription verification is read from the host.
   */
  readonly claudeSubscriptionAuth?: boolean | undefined;
}

// Revv thinking-effort tier → Codex `model_reasoning_effort`. Codex has no
// ultrathink/max tier, so those fall through to undefined (no override).
const CODEX_REASONING_EFFORT: Partial<Record<ThinkingEffort, string>> = {
  "extra-high": "xhigh",
  high: "high",
  medium: "medium",
  low: "low",
};

// Revv thinking-effort tier → Claude Code `MAX_THINKING_TOKENS` budget. Rough
// tiers mirroring Claude Code's own keyword ladder (think → ultrathink).
const CLAUDE_THINKING_TOKENS: Record<ThinkingEffort, number> = {
  low: 4_000,
  medium: 10_000,
  high: 24_000,
  "extra-high": 32_000,
  max: 48_000,
  ultrathink: 64_000,
};

// ── ACP agent credentials (agent-agnostic auth) ──────────────────────────────
//
// In-memory cache of per-agent credential env vars (`agentId → { ENV_VAR: value }`),
// seeded from SQLite at boot by `SettingsServiceLive` and refreshed on every
// connect/disconnect. SQLite stays authoritative (see the agent-subsystem
// invariants); this is a reconstructible cache read synchronously at spawn time.
// Each declared credential (see `ACP_AGENTS[].credentials`) is injected as its
// env var into the subprocess so the packaged LaunchAgent — which runs with a
// sparse env and can't reach the OS keychain where CLIs stash their interactive
// login — can authenticate. Without it, chat 401s and generation dies with
// "ACP connection closed".
type AgentCredentialMap = Record<string, Record<string, string>>;
let agentCredentialCache: AgentCredentialMap = {};

/** Replace the cached credential map (called at boot and on every write). */
export function setAgentCredentialCache(map: AgentCredentialMap): void {
  agentCredentialCache = map;
}

/** The stored value for one agent credential env var, or null. */
function storedCredential(agent: AcpAgentId, envVar: string): string | null {
  const value = agentCredentialCache[agent]?.[envVar]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Whether the inherited environment already proves the agent is authenticated —
 * its own env var, or any `alsoSatisfiedBy` var. Used ONLY for the missing/hint
 * check, NOT to gate injection: an `alsoSatisfiedBy` var may be a hazard we want
 * to override (see the field's doc), so injection keys off the own var alone.
 */
function credentialAuthedByEnv(cred: {
  envVar: string;
  alsoSatisfiedBy?: readonly string[];
}): boolean {
  return [cred.envVar, ...(cred.alsoSatisfiedBy ?? [])].some((v) => Boolean(process.env[v]));
}

/**
 * True when the agent declares credentials but none are satisfied — neither a
 * Revv-stored value nor a satisfying inherited env var for any of them. Used to
 * turn an opaque 401 / "ACP connection closed" into an actionable "connect it"
 * hint. Agents that declare no credentials (they self-authenticate) are never
 * missing.
 */
export function agentCredentialsMissing(agent: AcpAgentId): boolean {
  const creds = getAgentCredentials(agent);
  if (creds.length === 0) return false;
  return creds.every((c) => !storedCredential(agent, c.envVar) && !credentialAuthedByEnv(c));
}

/**
 * Append an actionable connect hint to a raw ACP error when it's likely an auth
 * failure — either the agent has no credential configured, or the message looks
 * like an auth/connection error (401, "ACP connection closed", expired token).
 */
export function withAgentAuthHint(agent: AcpAgentId, rawMessage: string): string {
  const creds = getAgentCredentials(agent);
  if (creds.length === 0) return rawMessage;
  const looksAuth = /401|unauthor|authenticat|invalid api key|oauth|connection closed/i.test(
    rawMessage,
  );
  if (!agentCredentialsMissing(agent) && !looksAuth) return rawMessage;
  const labels = creds.map((c) => c.label).join(" / ");
  return `${rawMessage}\n\nConnect ${getAcpAgent(agent).label} in Settings (add the ${labels}), then retry.`;
}

/**
 * Apply the `REVV_ACP_AGENT` env override (a testing / power-user knob) over a
 * persisted agent id. Returns the override when it names a valid registry agent,
 * otherwise the persisted id unchanged.
 */
export function applyAcpAgentOverride(agent: AcpAgentId): AcpAgentId {
  const override = serverEnv.acpAgent.trim();
  if (override && isAcpAgentId(override)) return override;
  return agent;
}

/**
 * Resolve the launch command + args + env for a registry agent, injecting the
 * selected model / thinking-effort / context-window the way each adapter accepts
 * them. ACP has no model protocol, so this is the only place a Revv selection
 * reaches the agent.
 */
export function resolveAcpLaunchById(id: AcpAgentId, config: AcpLaunchConfig = {}): AcpLaunch {
  if (serverEnv.acpCommand) {
    const args = serverEnv.acpArgs.trim().length > 0 ? serverEnv.acpArgs.trim().split(/\s+/) : [];
    return { command: serverEnv.acpCommand, args };
  }
  const def = getAcpAgent(id);
  const args = [...def.args];
  const env: Record<string, string> = {};
  const { model, thinkingEffort, contextWindow } = config;

  switch (id) {
    case "codex": {
      if (model) args.push("-c", `model=${JSON.stringify(model)}`);
      const effort = thinkingEffort ? CODEX_REASONING_EFFORT[thinkingEffort] : undefined;
      if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
      break;
    }
    case "claude-code": {
      if (model) env.ANTHROPIC_MODEL = model;
      // 1M context is on by default in Claude Code; disable it for the 200K tier.
      if (contextWindow) {
        env.CLAUDE_CODE_DISABLE_1M_CONTEXT = contextWindow === "1m" ? "false" : "true";
      }
      if (thinkingEffort) env.MAX_THINKING_TOKENS = String(CLAUDE_THINKING_TOKENS[thinkingEffort]);
      break;
    }
    case "opencode": {
      // opencode accepts `--model provider/model` at startup (same format as its config).
      if (model) args.push("--model", model);
      break;
    }
    case "cursor": {
      // The `cursor-agent-acp` adapter does not forward a model flag and ACP has
      // no `set_model`, so the selected model is saved as a preference but cannot
      // be propagated yet — Cursor uses its own configured model. Revisit if the
      // adapter gains a model passthrough.
      break;
    }
  }

  // Inject each Revv-stored credential as its declared env var, unless that var
  // is already inherited (leaves dev shells that export a key untouched, and
  // avoids handing the agent two conflicting credentials). Agent-agnostic: the
  // set of env vars comes entirely from the registry descriptor.
  for (const cred of getAgentCredentials(id)) {
    // Gate on the credential's OWN env var only — never `alsoSatisfiedBy`. A
    // hazard like a stale ANTHROPIC_API_KEY must not suppress injecting the
    // stored token; `buildAcpProcessEnv` then drops the hazard in its favor.
    if (process.env[cred.envVar]) continue;
    const value = storedCredential(id, cred.envVar);
    if (value) env[cred.envVar] = value;
  }

  return {
    command: def.command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/**
 * Build the environment for an ACP subprocess. Claude Code subscription auth is
 * fragile when a stale `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` is inherited:
 * Claude Code documents that those credentials can take precedence over a valid
 * Pro/Max subscription and produce 401s. When subscription credentials are
 * verified, drop the generic API credentials for the Claude ACP adapter while
 * preserving `CLAUDE_CODE_OAUTH_TOKEN` and all Revv model/context overrides.
 */
function buildAcpProcessEnv(
  id: AcpAgentId,
  inheritedEnv: Readonly<Record<string, string | undefined>>,
  launchEnv: Readonly<Record<string, string>> | undefined,
  path: string,
  options: AcpProcessEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (value !== undefined) env[key] = value;
  }

  // A Revv-injected OAuth token (in `launchEnv`) is itself proof of subscription
  // auth — the host probe (`detectClaudeSubscriptionAuth`) can't see it, since it
  // isn't in `process.env`. Treat it as subscription auth so the stale-key drop
  // below still fires; otherwise an inherited ANTHROPIC_API_KEY would shadow the
  // injected token and 401 (the exact failure this drop exists to prevent).
  const injectsClaudeOauthToken =
    id === "claude-code" && Boolean(launchEnv?.CLAUDE_CODE_OAUTH_TOKEN);
  const hasClaudeSubscriptionAuth =
    options.claudeSubscriptionAuth ??
    (id === "claude-code" && (injectsClaudeOauthToken || detectClaudeSubscriptionAuth()));
  if (id === "claude-code" && hasClaudeSubscriptionAuth) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  return {
    ...env,
    ...(launchEnv ?? {}),
    PATH: path,
  };
}

/**
 * Resolve a complete subprocess launch for an ACP agent. The connection layer
 * intentionally calls this instead of composing env itself: all per-adapter
 * launch quirks stay in this preset module, while `acp-connection` remains a
 * transport/pool implementation.
 */
export function resolveAcpProcessLaunchById(
  id: AcpAgentId,
  config: AcpLaunchConfig,
  inheritedEnv: Readonly<Record<string, string | undefined>>,
  path: string,
  options: AcpProcessEnvOptions = {},
): AcpProcessLaunch {
  const launch = resolveAcpLaunchById(id, config);
  return {
    command: launch.command,
    args: launch.args,
    env: buildAcpProcessEnv(id, inheritedEnv, launch.env, path, options),
  };
}

/**
 * Pick a model that is actually valid for an agent's catalog. The recap
 * override can pin a different agent than the global one, so the configured
 * `aiModel` (written against the global agent's catalog) may not belong to the
 * resolved agent. Guard against that: if the configured id isn't in the agent's
 * catalog, fall back to that agent's default model. opencode's catalog is
 * dynamic, so its models are taken on trust. Returns `undefined` only when
 * there is no configured model and no static default (caller supplies its own
 * fallback).
 */
export function resolveGenerationModel(
  agent: AcpAgentId,
  configuredModel: string | null | undefined,
): string | undefined {
  const caps = getAgentCapabilities(agent);
  if (caps.models === "dynamic") return configuredModel ?? undefined;
  if (configuredModel && caps.models.some((m) => m.value === configuredModel)) {
    return configuredModel;
  }
  return caps.models[0]?.value;
}

/**
 * Best-effort availability check for a registry agent's command. `npx`/`bunx`
 * are treated as always available; any other command is probed against the
 * user's login-shell PATH (see `isCommandOnPath`), so a server launched with a
 * sanitized PATH still finds shell-managed installs.
 */
export function isAcpAgentAvailable(id: AcpAgentId): boolean {
  const { command } = resolveAcpLaunchById(id);
  if (command === "npx" || command === "bunx") return true;
  return isCommandOnPath(command);
}
