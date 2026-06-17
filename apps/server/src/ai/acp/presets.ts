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

/**
 * Resolve the effective ACP launch command. An explicit `REVV_ACP_COMMAND`
 * override wins (with space-separated `REVV_ACP_ARGS`); otherwise the configured
 * preset's baked-in command is used, falling back to `claude-agent-acp`.
 */
export function resolveAcpLaunch(): AcpLaunch {
  if (serverEnv.acpCommand) {
    const args = serverEnv.acpArgs.trim().length > 0 ? serverEnv.acpArgs.trim().split(/\s+/) : [];
    return { command: serverEnv.acpCommand, args };
  }
  const preset = serverEnv.acpPreset as AcpPreset;
  if (preset !== "custom" && preset in PRESET_COMMANDS) {
    return PRESET_COMMANDS[preset as Exclude<AcpPreset, "custom">];
  }
  return PRESET_COMMANDS["claude-agent-acp"];
}

/**
 * Best-effort availability check for the resolved ACP command. `npx` is treated
 * as always available (it ships with Node/Bun and fetches the adapter on
 * demand); any other command is probed with `which`.
 */
export function isAcpAvailable(): boolean {
  const { command } = resolveAcpLaunch();
  if (command === "npx" || command === "bunx") return true;
  try {
    return execSync(`which ${command}`, { encoding: "utf-8", timeout: 3000 }).trim().length > 0;
  } catch {
    return false;
  }
}
