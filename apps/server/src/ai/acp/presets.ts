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
  isAcpAgentId,
  type ThinkingEffort,
} from "@revv/shared";
import { serverEnv } from "../../config";
import { isCommandOnPath } from "../providers/cli-agent";

export interface AcpLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Extra env vars merged over `process.env` when spawning (Claude Code model/effort/context). */
  readonly env?: Readonly<Record<string, string>>;
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

  return {
    command: def.command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
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
