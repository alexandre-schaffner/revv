// ── ACP agent adapters ───────────────────────────────────────────────────────
//
// One adapter per registry agent, keyed by `AcpAgentId`: adding an agent to
// `ACP_AGENTS` without an adapter here is a compile error. Everything outside
// `ai/acp/agents/` asks these functions, never an agent id, about per-agent
// behaviour.

import {
  ACP_AGENT_IDS,
  type AcpAgentId,
  type AgentStatus,
  type AgentStatusReport,
  getAcpAgent,
} from "@revv/shared";
import { hostEnv, invalidateUserPath } from "../host";
import { claudeCodeAdapter, forgetClaudeAuthProbe } from "./claude-code";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { opencodeAdapter } from "./opencode";
import type { AgentAdapter, AgentModelOption, AgentProcessPurpose } from "./types";

const AGENT_ADAPTERS: Record<AcpAgentId, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  opencode: opencodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
};

export function agentAdapter(id: AcpAgentId): AgentAdapter {
  return AGENT_ADAPTERS[id];
}

/** The environment for a process Revv runs for this agent (see `AgentProcessPurpose`). */
export function agentProcessEnv(
  id: AcpAgentId,
  purpose: AgentProcessPurpose,
): Record<string, string> {
  return agentAdapter(id).processEnv(hostEnv(), purpose);
}

/**
 * Onboarding's "installed": the vendor CLI is present, or the adapter has
 * credentials it can use without it. The CLI is what onboarding signs in
 * with, so an agent short of both still needs its install step. The runtime
 * gate is `isAgentLaunchable` (`launch.ts`); for agents whose adapter shells
 * out to the CLI, that gate requires the same binary.
 */
export function isAgentInstalled(id: AcpAgentId): boolean {
  const adapter = agentAdapter(id);
  return adapter.resolveBin() !== null || adapter.hasCredentialsWithoutCli();
}

/** Whether the agent is signed in, in the context its subprocess will run in. */
export function detectAgentAuth(id: AcpAgentId): boolean {
  return agentAdapter(id).authStatus().authed;
}

/** The interactive login argv with its binary resolved, or `null` when the agent needs none. */
export function agentLoginCommand(id: AcpAgentId): readonly string[] | null {
  const { cli } = getAcpAgent(id);
  if (!cli.loginArgs) return null;
  return [agentAdapter(id).resolveBin() ?? cli.bin, ...cli.loginArgs];
}

export function listAgentModels(id: AcpAgentId): Promise<AgentModelOption[]> {
  return agentAdapter(id).listModels();
}

/** Drop cached PATH and auth probes, after an install or a login changed them. */
export function invalidateAgentProbes(): void {
  invalidateUserPath();
  forgetClaudeAuthProbe();
}

/** Installed + signed in + manual login hint for every registry agent. */
export function detectAgentStatus(): AgentStatusReport {
  const agents = Object.fromEntries(
    ACP_AGENT_IDS.map((id) => {
      const { cli } = getAcpAgent(id);
      return [
        id,
        {
          installed: isAgentInstalled(id),
          ...agentAdapter(id).authStatus(),
          loginCommand: cli.loginArgs ? [cli.bin, ...cli.loginArgs].join(" ") : null,
        } satisfies AgentStatus,
      ];
    }),
  ) as Record<AcpAgentId, AgentStatus>;
  // Revv is macOS-only, so the embedded PTY login is always available.
  return { embeddedLoginSupported: true, agents };
}
