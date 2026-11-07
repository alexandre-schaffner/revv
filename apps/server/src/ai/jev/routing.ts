// Jev never names a model; it answers an abstract depth tier and effort tier,
// and this module maps each onto something concrete for the selected agent
// through the agent's own catalog (each model's `reviewDepth`), so an
// external API can never emit a model id the agent can't run.
//
// The two answers are routed independently, each with its own opt-in
// (`revv:auto`), gating, and slot in the override — neither can suppress the other.

import type { AcpAgentId, ReviewDepth, ThinkingEffort, ThinkingEffortSetting } from "@revv/shared";
import {
  clampThinkingEffort,
  getAgentCapabilities,
  isAutoSentinel,
  REVIEW_DEPTHS,
} from "@revv/shared";

/**
 * What the orchestrator threads into the agent launch when it overrides.
 * Both fields are independently optional: depth and effort are separate
 * questions with separate confidences and opt-ins, so one going unapplied
 * must not take the other down with it.
 */
export interface GenerationLaunchOverride {
  readonly model?: string | undefined;
  readonly thinkingEffort?: ThinkingEffort | undefined;
}

/**
 * Minimum confidence in `review_depth` before it can move the model, plus the
 * minimum margin over the runner-up. Kept strict: an unapplied override costs
 * nothing, since the configured model still runs.
 */
export const DEPTH_CONFIDENCE_FLOOR = 0.6;
export const DEPTH_MARGIN_FLOOR = 0.15;

/**
 * The agent's catalog models that sit on the depth ladder. Empty = no-op for
 * the model half (configured model stands); effort routing is unaffected.
 * opencode's catalog is fetched live, so it has none.
 */
function ladderModels(agent: AcpAgentId) {
  const { models } = getAgentCapabilities(agent);
  return models === "dynamic" ? [] : models.filter((m) => m.reviewDepth !== undefined);
}

/**
 * The abstract effort tier Jev answers, mapped onto Revv's ladder. Asked as
 * its own question rather than derived from `depth`: how intricate a change
 * is to understand and how much deliberation it deserves are related but not
 * the same. `clampThinkingEffort` steps the answer down to what the agent offers.
 */
export const REASONING_EFFORTS = ["minimal", "standard", "thorough", "exhaustive"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const EFFORT_TIERS: Readonly<Record<ReasoningEffort, ThinkingEffort>> = {
  minimal: "low",
  standard: "medium",
  thorough: "high",
  exhaustive: "max",
};

function ladderIndex(agent: AcpAgentId, model: string | null | undefined): number | null {
  const depth = ladderModels(agent).find((m) => m.value === model)?.reviewDepth;
  return depth === undefined ? null : REVIEW_DEPTHS.indexOf(depth);
}

export interface RouteSizingInput {
  readonly agent: AcpAgentId;
  readonly depth: ReviewDepth;
  readonly confidence: number;
  /** Per-label probabilities, used for the runner-up margin. */
  readonly probabilities: Readonly<Record<string, number>>;
  /**
   * The model the user has configured. A real model id is a floor: the
   * override may raise it, never lower it. {@link AUTO_SENTINEL} means no
   * floor, so the routed tier applies outright, including a downgrade.
   */
  readonly configuredModel: string | null | undefined;
  /**
   * The effort the user has configured. {@link AUTO_SENTINEL} is the opt-in;
   * anything else is a pin left strictly alone — unlike the model, no
   * "raise but never lower" middle ground.
   */
  readonly configuredEffort: ThinkingEffortSetting | null | undefined;
  /** Jev's reasoning-effort answer, clamped to the agent's own ladder. */
  readonly reasoningEffort: ReasoningEffort;
}

/**
 * `null` means "leave the configured model alone". Biased upward against a
 * pin, never down: the cost is asymmetric (an over-powered model wastes cents,
 * an under-powered one erodes trust), so a downgrade only happens once the
 * user has explicitly declined to pin ({@link AUTO_SENTINEL}).
 */
function routeModel(input: RouteSizingInput): string | null {
  const target = ladderModels(input.agent).find((m) => m.reviewDepth === input.depth);
  if (!target) return null;

  if (input.confidence < DEPTH_CONFIDENCE_FLOOR) return null;
  if (margin(input.probabilities) < DEPTH_MARGIN_FLOOR) return null;

  const targetIndex = REVIEW_DEPTHS.indexOf(input.depth);
  if (!isAutoSentinel(input.configuredModel)) {
    const currentIndex = ladderIndex(input.agent, input.configuredModel);
    // An off-ladder pinned model is left alone: no way to tell if the routed tier is an upgrade or downgrade.
    if (currentIndex === null || targetIndex <= currentIndex) return null;
  }

  return target.value;
}

/**
 * Resolve the effort half. `null` means "leave the configured effort alone".
 * Gated only on the opt-in — no depth ladder, no confidence floor, since
 * under {@link AUTO_SENTINEL} there's no pin to protect.
 */
function routeEffort(input: RouteSizingInput): ThinkingEffort | null {
  if (!isAutoSentinel(input.configuredEffort)) return null;
  // Clamped, not filtered: an agent below the answered tier gets its strongest available tier, not nothing.
  return clampThinkingEffort(input.agent, EFFORT_TIERS[input.reasoningEffort]) ?? null;
}

export function routeSizing(input: RouteSizingInput): GenerationLaunchOverride | null {
  const model = routeModel(input);
  const thinkingEffort = routeEffort(input);
  if (model === null && thinkingEffort === null) return null;
  return {
    ...(model !== null ? { model } : {}),
    ...(thinkingEffort !== null ? { thinkingEffort } : {}),
  };
}

function margin(probabilities: Readonly<Record<string, number>>): number {
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  if (sorted.length < 2) return 1;
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}
