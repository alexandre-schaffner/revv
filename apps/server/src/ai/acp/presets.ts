// ── ACP launch presets ───────────────────────────────────────────────────────
//
// Maps an agent-agnostic preset name to the subprocess command that starts an
// ACP (Agent Client Protocol) agent over stdio. The whole point of the ACP
// adapter is that one transport drives any of these — the only thing that
// changes per agent is the launch command. A user can pin a custom command via
// `REVV_ACP_COMMAND` / `REVV_ACP_ARGS` (consumed in config.ts) to point at any
// ACP-compliant binary.

import { execSync } from "node:child_process";
import { serverEnv } from "../../config";
import type { AgentId } from "../../services/Settings";

export type AcpPreset = "claude-agent-acp" | "opencode-acp" | "gemini" | "codex-acp" | "custom";

export interface AcpLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

// Baked-in launch commands per preset. `npx -y` lets the claude/codex adapters
// run without a global install; opencode/gemini are expected on PATH.
const PRESET_COMMANDS: Record<Exclude<AcpPreset, "custom">, AcpLaunch> = {
  "claude-agent-acp": { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] },
  "opencode-acp": { command: "opencode", args: ["acp"] },
  gemini: { command: "gemini", args: ["--experimental-acp"] },
  "codex-acp": { command: "npx", args: ["-y", "@zed-industries/codex-acp"] },
};

const PRESET_BY_AGENT: Record<AgentId, Exclude<AcpPreset, "custom" | "gemini">> = {
  claude: "claude-agent-acp",
  opencode: "opencode-acp",
  codex: "codex-acp",
};

function argsForAgent(agent: AgentId, model: string | undefined): readonly string[] {
  const launch = PRESET_COMMANDS[PRESET_BY_AGENT[agent]];
  if (agent !== "codex" || !model) return launch.args;

  // codex-acp forwards Codex CLI config overrides. Keep this at process launch
  // so the ACP session is born under the selected model.
  return [...launch.args, "-c", `model=${JSON.stringify(model)}`];
}

/**
 * Resolve the effective ACP launch command. An explicit `REVV_ACP_COMMAND`
 * override wins (with space-separated `REVV_ACP_ARGS`); otherwise the selected
 * Revv agent determines the baked-in ACP adapter.
 */
export function resolveAcpLaunch(agent: AgentId, model?: string | undefined): AcpLaunch {
  if (serverEnv.acpCommand) {
    const args = serverEnv.acpArgs.trim().length > 0 ? serverEnv.acpArgs.trim().split(/\s+/) : [];
    return { command: serverEnv.acpCommand, args };
  }
  const preset = PRESET_BY_AGENT[agent];
  return { command: PRESET_COMMANDS[preset].command, args: argsForAgent(agent, model) };
}

/**
 * Best-effort availability check for the resolved ACP command. `npx` is treated
 * as always available (it ships with Node/Bun and fetches the adapter on
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
