// ── Sizing answers → launch config ──────────────────────────────────────────
//
// Jev never names a model; it answers an abstract depth tier and effort tier,
// and this module maps each onto something concrete for the selected agent
// via a local table, so an external API can never emit a model id the agent
// can't run.
//
// The two answers are routed independently, each with its own opt-in
// (`revv:auto`), gating, and slot in the override — neither can suppress the other.

import type { AcpAgentId, ThinkingEffort, ThinkingEffortSetting } from "@revv/shared";
import { clampThinkingEffort, getAgentCapabilities, isAutoSentinel } from "@revv/shared";

/** The abstract tier Jev answers. Ordered — index is the ladder position. */
export const REVIEW_DEPTHS = ["shallow", "standard", "deep"] as const;
export type ReviewDepth = (typeof REVIEW_DEPTHS)[number];

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
 * Per-agent depth ladder, lowest tier first. Absent agent = no-op for the
 * model half (configured model stands); effort routing is unaffected.
 *
 *   • **opencode**: 75+ models fetched live (`caps.models === "dynamic"`), no static table.
 *   • **codex**: three sibling GPT-5.6 variants, not a cost/capability ladder to order.
 *   • **cursor**: ACP adapter doesn't forward a selected model at all.
 */
const DEPTH_LADDERS: Partial<Record<AcpAgentId, Readonly<Record<ReviewDepth, string>>>> = {
  "claude-code": {
    shallow: "claude-haiku-4-5-20251001",
    standard: "claude-sonnet-5",
    deep: "claude-opus-5",
  },
};

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

/** Position of `model` on the agent's ladder, or `null` when it isn't on it. */
function ladderIndex(agent: AcpAgentId, model: string | null | undefined): number | null {
  const ladder = DEPTH_LADDERS[agent];
  if (!ladder || !model) return null;
  const found = REVIEW_DEPTHS.findIndex((depth) => ladder[depth] === model);
  return found === -1 ? null : found;
}

export interface RouteSizingInput {
  readonly agent: AcpAgentId;
  readonly depth: ReviewDepth;
  /** Calibrated confidence in `depth`, from the choice answer. */
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
 * Resolve the model half. `null` means "leave the configured model alone" —
 * returned when the agent has no depth ladder, confidence/margin is below
 * floor, or a pinned model is already at or above the routed tier.
 *
 * Biased upward against a pin, never down: the cost is asymmetric (an
 * over-powered model wastes cents, an under-powered one erodes trust), so a
 * downgrade only happens once the user has explicitly declined to pin
 * ({@link AUTO_SENTINEL}).
 */
function routeModel(input: RouteSizingInput): string | null {
  const ladder = DEPTH_LADDERS[input.agent];
  if (!ladder) return null;

  if (input.confidence < DEPTH_CONFIDENCE_FLOOR) return null;
  if (margin(input.probabilities) < DEPTH_MARGIN_FLOOR) return null;

  const targetIndex = REVIEW_DEPTHS.indexOf(input.depth);
  if (!isAutoSentinel(input.configuredModel)) {
    const currentIndex = ladderIndex(input.agent, input.configuredModel);
    // An off-ladder pinned model is left alone: no way to tell if the routed tier is an upgrade or downgrade.
    if (currentIndex === null || targetIndex <= currentIndex) return null;
  }

  const model = ladder[input.depth];
  const caps = getAgentCapabilities(input.agent);
  // Guard against the table drifting from the registry: a delisted model must never reach the launch.
  if (caps.models !== "dynamic" && !caps.models.some((m) => m.value === model)) return null;
  return model;
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

/**
 * Resolve a launch override, or `null` when neither half applies. The two
 * halves are decided independently and either can be absent.
 */
export function routeSizing(input: RouteSizingInput): GenerationLaunchOverride | null {
  const model = routeModel(input);
  const thinkingEffort = routeEffort(input);
  if (model === null && thinkingEffort === null) return null;
  return {
    ...(model !== null ? { model } : {}),
    ...(thinkingEffort !== null ? { thinkingEffort } : {}),
  };
}

/** Gap between the top two probabilities; `1` when there's only one label. */
function margin(probabilities: Readonly<Record<string, number>>): number {
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  if (sorted.length < 2) return 1;
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}
