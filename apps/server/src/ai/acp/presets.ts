// ── ACP launch resolution (server) ───────────────────────────────────────────
//
// The ACP agent registry itself (id, label, command, args, capabilities) is the
// single source of truth in `@revv/shared` (`ACP_AGENTS`) so the web provider
// list / selectors and the server launch stay in sync — adding an agent is one
// entry there. This module holds the server-only concerns: the `REVV_ACP_AGENT`
// / `REVV_ACP_COMMAND` overrides, availability checks, and — since ACP has no
// model protocol — per-adapter injection of the selected model / thinking-effort
// / context-window at launch time (args for Codex/opencode, env for Claude Code).

import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
  type AcpAgentId,
  type ContextWindow,
  clampThinkingEffort,
  getAcpAgent,
  getAcpAgentDefaultModel,
  getAgentCapabilities,
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
  /**
   * Isolated `CLAUDE_CONFIG_DIR` to inject for claude-code. Resolved centrally
   * in `acp-connection.ts#spawnConnection` from `serverEnv.claudeConfigDir` /
   * `claudeConfigIsolation` — never supplied by a caller. Ignored for every
   * other adapter (see the `id === "claude-code"` guard below).
   */
  readonly claudeConfigDir?: string | undefined;
}

// Revv thinking-effort tier → Codex `model_reasoning_effort`. Codex's ladder is
// per-model (`supported_reasoning_levels` in the catalog it fetches from
// OpenAI), so the tier is clamped to the selected model's capabilities before
// it gets here — see `clampThinkingEffort`.
const CODEX_REASONING_EFFORT: Record<ThinkingEffort, string> = {
  ultrathink: "ultra",
  max: "max",
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

function executableExists(command: string, path: string): boolean {
  const candidates = isAbsolute(command)
    ? [command]
    : path
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, command));

  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function stripNpxYes(args: readonly string[]): readonly string[] {
  return args[0] === "-y" || args[0] === "--yes" ? args.slice(1) : args;
}

function resolvePackageRunner(
  launch: AcpLaunch,
  path: string,
): Pick<AcpLaunch, "command" | "args"> {
  if (launch.command !== "npx") {
    return { command: launch.command, args: launch.args };
  }
  if (executableExists("npx", path)) {
    return { command: launch.command, args: launch.args };
  }

  const args = stripNpxYes(launch.args);
  if (executableExists("bunx", path)) {
    return { command: "bunx", args };
  }
  if (executableExists("bun", path)) {
    return { command: "bun", args: ["x", ...args] };
  }

  return { command: launch.command, args: launch.args };
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
      // Clamp rather than trust the persisted tier: model and effort are stored
      // independently, so a tier picked on a frontier model can outlive a switch
      // to one that rejects it — Codex errors on an unsupported level.
      const tier = clampThinkingEffort(id, model ?? getAcpAgentDefaultModel(id), thinkingEffort);
      if (tier)
        args.push("-c", `model_reasoning_effort=${JSON.stringify(CODEX_REASONING_EFFORT[tier])}`);
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
      // `opencode acp` does NOT accept a `--model` flag (unlike `opencode run` /
      // the TUI) — passing one makes yargs print help and exit 1, which surfaces
      // as "ACP connection closed". Inject the model the way the ACP subcommand
      // honors it: an inline config override via OPENCODE_CONFIG_CONTENT, whose
      // `model` field takes the same `provider/model` format as the config file.
      if (model) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model });
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

  const hasClaudeSubscriptionAuth =
    options.claudeSubscriptionAuth ?? (id === "claude-code" && detectClaudeSubscriptionAuth());
  if (id === "claude-code") {
    if (hasClaudeSubscriptionAuth) {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    if (options.claudeConfigDir) env.CLAUDE_CONFIG_DIR = options.claudeConfigDir;
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
  const runner = resolvePackageRunner(launch, path);
  return {
    command: runner.command,
    args: runner.args,
    env: buildAcpProcessEnv(id, inheritedEnv, launch.env, path, options),
  };
}

/**
 * Pick a model that is actually valid for an agent's catalog. The recap
 * override can pin a different agent than the global one, so the configured
 * `aiModel` (written against the global agent's catalog) may not belong to the
 * resolved agent. Guard against that: if the configured id isn't in the agent's
 * catalog, fall back to that agent's default model. opencode's catalog is
 * dynamic, so configured opencode models are taken on trust.
 */
export function resolveGenerationModel(
  agent: AcpAgentId,
  configuredModel: string | null | undefined,
): string | undefined {
  const caps = getAgentCapabilities(agent);
  if (caps.models === "dynamic") return configuredModel ?? getAcpAgentDefaultModel(agent);
  if (configuredModel && caps.models.some((m) => m.value === configuredModel)) {
    return configuredModel;
  }
  const defaultModel = getAcpAgentDefaultModel(agent);
  if (caps.models.some((m) => m.value === defaultModel)) return defaultModel;
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
  if (command === "npx") {
    return isCommandOnPath("npx") || isCommandOnPath("bunx") || isCommandOnPath("bun");
  }
  if (command === "bunx") return isCommandOnPath("bunx") || isCommandOnPath("bun");
  return isCommandOnPath(command);
}
