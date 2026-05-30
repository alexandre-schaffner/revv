import type { ThinkingEffort } from "@revv/shared";

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

const DEFAULT_MODEL_BY_AGENT: Record<"opencode" | "claude", string> = {
  opencode: "opencode/big-pickle",
  claude: "claude-sonnet-4-6",
};

export function getDefaultModel(agent: "opencode" | "claude"): string {
  return DEFAULT_MODEL_BY_AGENT[agent];
}

// Low-cost defaults for the right-panel suggestions feature. Pinned to the
// cheapest reasonable model in each agent's catalog so generating PR-aware
// prompts on every PR open doesn't burn Sonnet/Opus tokens.
const DEFAULT_SUGGESTIONS_MODEL_BY_AGENT: Record<"opencode" | "claude", string> = {
  opencode: "opencode/big-pickle",
  claude: "claude-haiku-4-5-20251001",
};

export function getDefaultSuggestionsModel(agent: "opencode" | "claude"): string {
  return DEFAULT_SUGGESTIONS_MODEL_BY_AGENT[agent];
}

// ThinkingEffort only applies to Claude Code
export function agentSupportsThinkingEffort(agent: "opencode" | "claude"): boolean {
  return agent === "claude";
}

// ContextWindow only applies to Claude Code
export function agentSupportsContextWindow(agent: "opencode" | "claude"): boolean {
  return agent === "claude";
}
