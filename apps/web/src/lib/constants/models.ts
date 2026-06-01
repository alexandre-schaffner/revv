import type { AiAgent, ThinkingEffort } from "@revv/shared";

export type ModelOption = { label: string; value: string };

export const THINKING_EFFORT_OPTIONS: { label: string; value: ThinkingEffort }[] = [
  { label: "Ultrathink", value: "ultrathink" },
  { label: "Max", value: "max" },
  { label: "Extra High", value: "extra-high" },
  { label: "High", value: "high" },
  { label: "Medium", value: "medium" },
  { label: "Low", value: "low" },
];

/** Thinking effort values that are only available for Claude Opus 4.8. */
export const OPUS_ONLY_EFFORTS: Set<ThinkingEffort> = new Set(["max", "extra-high"]);

/**
 * Reasoning-effort levels Codex exposes (mapped to the codex SDK's
 * low/medium/high/xhigh `modelReasoningEffort`). The Claude-only `ultrathink`
 * / `max` tiers are not offered for codex.
 */
export const CODEX_EFFORTS: Set<ThinkingEffort> = new Set(["extra-high", "high", "medium", "low"]);

/**
 * Thinking-effort options to show for a given agent + model. Centralizes the
 * per-agent/per-model filtering both the settings modal and the top-bar quick
 * selector consume:
 *   - codex: the four codex reasoning-effort levels.
 *   - claude opus 4.8: every option.
 *   - claude (non-opus): all but the opus-only tiers.
 */
export function thinkingEffortOptionsFor(
  agent: AiAgent,
  model: string,
): { label: string; value: ThinkingEffort }[] {
  if (agent === "codex") {
    return THINKING_EFFORT_OPTIONS.filter((o) => CODEX_EFFORTS.has(o.value));
  }
  if (model === "claude-opus-4-8") return THINKING_EFFORT_OPTIONS;
  return THINKING_EFFORT_OPTIONS.filter((o) => !OPUS_ONLY_EFFORTS.has(o.value));
}

const DEFAULT_MODEL_BY_AGENT: Record<AiAgent, string> = {
  opencode: "opencode/big-pickle",
  claude: "claude-sonnet-4-6",
  codex: "gpt-5.5",
};

export function getDefaultModel(agent: AiAgent): string {
  return DEFAULT_MODEL_BY_AGENT[agent];
}

// Low-cost defaults for the right-panel suggestions feature. Pinned to the
// cheapest reasonable model in each agent's catalog so generating PR-aware
// prompts on every PR open doesn't burn Sonnet/Opus tokens.
const DEFAULT_SUGGESTIONS_MODEL_BY_AGENT: Record<AiAgent, string> = {
  opencode: "opencode/big-pickle",
  claude: "claude-haiku-4-5-20251001",
  codex: "gpt-5.4-mini",
};

export function getDefaultSuggestionsModel(agent: AiAgent): string {
  return DEFAULT_SUGGESTIONS_MODEL_BY_AGENT[agent];
}

// ThinkingEffort applies to Claude Code and Codex (codex maps it to
// `modelReasoningEffort`); opencode has no equivalent knob.
export function agentSupportsThinkingEffort(agent: AiAgent): boolean {
  return agent === "claude" || agent === "codex";
}

// ContextWindow only applies to Claude Code
export function agentSupportsContextWindow(agent: AiAgent): boolean {
  return agent === "claude";
}
