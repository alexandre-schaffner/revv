import type { AcpAgentId, ThinkingEffort } from "@revv/shared";

export type ModelOption = { label: string; value: string };

// Display labels for every thinking-effort tier. Which tiers a given agent
// actually offers is declared per-agent in the ACP registry capabilities
// (`getAgentCapabilities`); this is just the label source the selector filters.
export const THINKING_EFFORT_OPTIONS: { label: string; value: ThinkingEffort }[] = [
  { label: "Ultrathink", value: "ultrathink" },
  { label: "Max", value: "max" },
  { label: "Extra High", value: "extra-high" },
  { label: "High", value: "high" },
  { label: "Medium", value: "medium" },
  { label: "Low", value: "low" },
];

const DEFAULT_MODEL_BY_AGENT: Record<AcpAgentId, string> = {
  opencode: "opencode/big-pickle",
  "claude-code": "claude-sonnet-4-6",
  codex: "gpt-5.5",
  cursor: "auto",
};

export function getDefaultModel(agent: AcpAgentId): string {
  return DEFAULT_MODEL_BY_AGENT[agent];
}

// Low-cost defaults for the right-panel suggestions feature. Pinned to the
// cheapest reasonable model in each agent's catalog so generating PR-aware
// prompts on every PR open doesn't burn Sonnet/Opus tokens.
const DEFAULT_SUGGESTIONS_MODEL_BY_AGENT: Record<AcpAgentId, string> = {
  opencode: "opencode/big-pickle",
  "claude-code": "claude-haiku-4-5-20251001",
  codex: "gpt-5.4-mini",
  cursor: "auto",
};

export function getDefaultSuggestionsModel(agent: AcpAgentId): string {
  return DEFAULT_SUGGESTIONS_MODEL_BY_AGENT[agent];
}
