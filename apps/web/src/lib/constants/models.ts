import { THINKING_EFFORT_ORDER, type ThinkingEffort } from "@revv/shared";

export type ModelOption = { label: string; value: string };

const THINKING_EFFORT_LABELS: Record<ThinkingEffort, string> = {
  ultra: "Ultra",
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
