import {
  type AcpAgentId,
  getAcpAgentDefaultModel,
  THINKING_EFFORT_ORDER,
  type ThinkingEffort,
} from "@revv/shared";

export type ModelOption = { label: string; value: string };

const THINKING_EFFORT_LABELS: Record<ThinkingEffort, string> = {
  ultrathink: "Ultrathink",
  max: "Max",
  "extra-high": "Extra High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// Display labels for every thinking-effort tier, strongest first. Which tiers a
// given agent+model actually offers comes from the ACP registry
// (`getModelThinkingEfforts`); this is just the label source the selector
// filters. Ordering is inherited from the registry so the two can't drift.
export const THINKING_EFFORT_OPTIONS: { label: string; value: ThinkingEffort }[] =
  THINKING_EFFORT_ORDER.map((value) => ({ label: THINKING_EFFORT_LABELS[value], value }));

export function getDefaultModel(agent: AcpAgentId): string {
  return getAcpAgentDefaultModel(agent);
}

// Low-cost defaults for the right-panel suggestions feature. Pinned to the
// cheapest reasonable model in each agent's catalog so generating PR-aware
// prompts on every PR open doesn't burn Sonnet/Opus tokens.
const DEFAULT_SUGGESTIONS_MODEL_BY_AGENT: Record<AcpAgentId, string> = {
  opencode: "opencode/big-pickle",
  "claude-code": "claude-haiku-4-5-20251001",
  codex: "gpt-5.6-luna",
  cursor: "auto",
};

export function getDefaultSuggestionsModel(agent: AcpAgentId): string {
  return DEFAULT_SUGGESTIONS_MODEL_BY_AGENT[agent];
}
