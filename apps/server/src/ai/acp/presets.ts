// ── ACP agent registry ───────────────────────────────────────────────────────
//
// Single source of truth for the ACP (Agent Client Protocol) agents Revv can
// drive. The whole point of the ACP adapter is that one transport drives any of
// these — the ONLY per-agent knowledge is the launch command. So adding support
// for a new ACP-compatible agent is a one-line entry in `ACP_AGENTS` below;
// everything else (connection pooling, session lifecycle, decoding, plan mode,
// availability checks, selection) is generic.
//
// Selection, in priority order:
//   1. `REVV_ACP_COMMAND` (+ `REVV_ACP_ARGS`) — pin a raw command for any
//      ACP-compliant binary not in the registry.
//   2. `REVV_ACP_AGENT=<id>` — pick any registry agent by id, regardless of the
//      legacy `aiAgent` setting. This is the knob for trying a new agent.
//   3. The legacy `aiAgent` setting (claude / opencode / codex), mapped to its
//      registry entry for backward compatibility.

import { execSync } from "node:child_process";
import { serverEnv } from "../../config";
import type { AgentId } from "../../services/Settings";

export interface AcpAgentDef {
  /** Human-readable label (for settings UI / diagnostics). */
  readonly label: string;
  /** argv[0] — `npx`/`bunx` to run an adapter on demand, or a binary on PATH. */
  readonly command: string;
  /** Fixed launch args. */
  readonly args: readonly string[];
  /**
   * Optional extra args to pin the selected Revv model at process launch, for
   * adapters that accept a model via CLI config (e.g. codex `-c model=…`). Most
   * agents pick the model agent-side and omit this.
   */
  readonly modelArg?: (model: string) => readonly string[];
}

// ⇩ Add a new ACP agent here — one entry is all it takes. ⇩
export const ACP_AGENTS = {
  "claude-code": {
    label: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  },
  opencode: { label: "opencode", command: "opencode", args: ["acp"] },
  codex: {
    label: "Codex",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp"],
    modelArg: (model) => ["-c", `model=${JSON.stringify(model)}`],
  },
  gemini: { label: "Gemini", command: "gemini", args: ["--experimental-acp"] },
  cursor: { label: "Cursor", command: "npx", args: ["-y", "cursor-agent-acp"] },
} as const satisfies Record<string, AcpAgentDef>;

export type AcpAgentId = keyof typeof ACP_AGENTS;

export interface AcpLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

// Back-compat: the legacy `aiAgent` enum maps onto registry entries. New agents
// (e.g. cursor, gemini) are reached via `REVV_ACP_AGENT`, not this map — so
// adding one needs no change to the `AiAgent` type or its many call sites.
const AGENT_TO_ACP: Record<AgentId, AcpAgentId> = {
  claude: "claude-code",
  opencode: "opencode",
  codex: "codex",
};

function isAcpAgentId(value: string): value is AcpAgentId {
  return value in ACP_AGENTS;
}

/**
 * Which registry agent to launch: an explicit `REVV_ACP_AGENT` override wins,
 * otherwise the legacy `aiAgent` mapping.
 */
export function resolveAcpAgentId(agent: AgentId): AcpAgentId {
  const override = serverEnv.acpAgent.trim();
  if (override && isAcpAgentId(override)) return override;
  return AGENT_TO_ACP[agent];
}

/**
 * Resolve the effective ACP launch command. A raw `REVV_ACP_COMMAND` override
 * wins; otherwise the resolved registry agent supplies the command (+ optional
 * model arg).
 */
export function resolveAcpLaunch(agent: AgentId, model?: string | undefined): AcpLaunch {
  if (serverEnv.acpCommand) {
    const args = serverEnv.acpArgs.trim().length > 0 ? serverEnv.acpArgs.trim().split(/\s+/) : [];
    return { command: serverEnv.acpCommand, args };
  }
  const def: AcpAgentDef = ACP_AGENTS[resolveAcpAgentId(agent)];
  const args = model && def.modelArg ? [...def.args, ...def.modelArg(model)] : [...def.args];
  return { command: def.command, args };
}

/**
 * Best-effort availability check for the resolved ACP command. `npx`/`bunx` are
 * treated as always available (they ship with Node/Bun and fetch the adapter on
 * demand); any other command is probed with `which`.
 */
export function isAcpAvailable(agent: AgentId): boolean {
  const { command } = resolveAcpLaunch(agent);
  if (command === "npx" || command === "bunx") return true;
  try {
    return execSync(`which ${command}`, { encoding: "utf-8", timeout: 3000 }).trim().length > 0;
  } catch {
    return false;
  }
}
