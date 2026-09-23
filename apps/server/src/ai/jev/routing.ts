// ── Sizing answers → launch config ───────────────────────────────────────────
//
// Jev never names a model. It answers an abstract depth tier and an abstract
// effort tier; this module maps each onto something concrete for the
// *selected* agent. An external API must not be able to emit a model id the
// agent can't run — and the mapping is a local table, so a new model in the
// registry is a deliberate edit here rather than something the API can reach
// for.
//
// The two answers are routed **independently**. Each has its own opt-in
// (`revv:auto` in the respective setting), its own gating, and its own slot
// in the override, so neither can silently suppress the other.

import type { AcpAgentId, ThinkingEffort, ThinkingEffortSetting } from "@revv/shared";
import { clampThinkingEffort, getAgentCapabilities, isAutoSentinel } from "@revv/shared";

/** The abstract tier Jev answers. Ordered — index is the ladder position. */
export const REVIEW_DEPTHS = ["shallow", "standard", "deep"] as const;
export type ReviewDepth = (typeof REVIEW_DEPTHS)[number];

/**
 * What the orchestrator threads into the agent launch when it overrides.
 *
 * **Both fields are independently optional.** Depth and effort are separate
 * questions with separate confidences and separate opt-ins, so a pinned
 * model, an agent without a depth ladder, or an ambiguous depth answer must
 * not take the reasoning-effort answer down with it.
 */
export interface GenerationLaunchOverride {
  readonly model?: string | undefined;
  readonly thinkingEffort?: ThinkingEffort | undefined;
}

/**
 * Minimum confidence in `review_depth` before the answer is allowed to move
 * the model, plus the minimum margin the winner must hold over the runner-up.
 *
 * Both are placeholders until there's real data — see the verification plan.
 * They're deliberately on the strict side: an unapplied override costs
 * nothing, since the configured model still runs.
 */
export const DEPTH_CONFIDENCE_FLOOR = 0.6;
export const DEPTH_MARGIN_FLOOR = 0.15;

/**
 * Per-agent depth ladder, lowest tier first. An agent absent from this table
 * is a deliberate no-op: the model half resolves to `null` and the configured
 * model stands. The effort half is unaffected — it does not consult this
 * table at all.
 *
 *   • **opencode** exposes 75+ models fetched live (`caps.models === "dynamic"`),
 *     so there is no static table to write. Documented in the Settings UI.
 *   • **codex** ships three sibling GPT-5.6 variants rather than a cost or
 *     capability ladder; picking an order would be an invention, and inventing
 *     one would silently downgrade reviews.
 *   • **cursor**'s ACP adapter does not forward a selected model at all, so
 *     routing there would be a lie.
 */
const DEPTH_LADDERS: Partial<Record<AcpAgentId, Readonly<Record<ReviewDepth, string>>>> = {
  "claude-code": {
    shallow: "claude-haiku-4-5-20251001",
    standard: "claude-sonnet-5",
    deep: "claude-opus-5",
  },
};

/**
 * The abstract effort tier Jev answers, mapped onto Revv's ladder.
 *
 * Asked as its own question rather than derived from `depth`: how intricate a
 * change is to *understand* and how much deliberation it is worth are related
 * but not the same. A sprawling-but-shallow refactor can want more thinking
 * than its depth suggests, and a small cryptographic change can want a lot
 * more. `clampThinkingEffort` then steps the answer down to whatever the
 * selected agent actually offers.
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
   * The model the user has configured. A real model id is a *floor*: the
   * override may raise it, never lower it. {@link AUTO_SENTINEL} means
   * the user declined to pin one, so there is no floor and the routed tier
   * applies outright — including a downgrade to a cheaper model.
   */
  readonly configuredModel: string | null | undefined;
  /**
   * The effort the user has configured. {@link AUTO_SENTINEL} is the
   * opt-in: anything else is a pin and is left strictly alone. Unlike the
   * model there is no "raise but never lower" middle ground — a pinned effort
   * is a direct instruction about how much thinking to buy, and second-
   * guessing it upward would be spending the user's money against their
   * stated preference.
   */
  readonly configuredEffort: ThinkingEffortSetting | null | undefined;
  /** Jev's reasoning-effort answer, clamped to the agent's own ladder. */
  readonly reasoningEffort: ReasoningEffort;
}

/**
 * Resolve the model half. `null` means "leave the configured model alone".
 *
 * Returns `null` when:
 *   • the agent has no depth ladder (see {@link DEPTH_LADDERS});
 *   • confidence or the runner-up margin is below the floor;
 *   • a pinned model is at or above the routed tier.
 *
 * **Against a pinned model, biased upward and never down.** The cost is
 * asymmetric: an over-powered model on a trivial PR wastes cents, while an
 * under-powered model on an intricate one produces a review the user stops
 * trusting. So a low-confidence answer and a "this could be shallower" answer
 * both resolve to the same thing — leave the pinned model alone. Only when
 * the user has explicitly declined to pin one ({@link AUTO_SENTINEL})
 * does a downgrade become theirs to have asked for.
 */
function routeModel(input: RouteSizingInput): string | null {
  const ladder = DEPTH_LADDERS[input.agent];
  if (!ladder) return null;

  if (input.confidence < DEPTH_CONFIDENCE_FLOOR) return null;
  if (margin(input.probabilities) < DEPTH_MARGIN_FLOOR) return null;

  const targetIndex = REVIEW_DEPTHS.indexOf(input.depth);
  if (!isAutoSentinel(input.configuredModel)) {
    const currentIndex = ladderIndex(input.agent, input.configuredModel);
    // An off-ladder pinned model (a delisted id, or one chosen deliberately
    // from outside the ladder) is left alone: there's no way to tell whether
    // the routed tier is an upgrade or a downgrade from it.
    if (currentIndex === null || targetIndex <= currentIndex) return null;
  }

  const model = ladder[input.depth];
  const caps = getAgentCapabilities(input.agent);
  // Belt and braces against the table drifting from the registry: a model
  // the agent no longer lists must never reach the launch.
  if (caps.models !== "dynamic" && !caps.models.some((m) => m.value === model)) return null;
  return model;
}

/**
 * Resolve the effort half. `null` means "leave the configured effort alone".
 *
 * Deliberately gated on nothing but the opt-in. No depth ladder is consulted
 * — every agent with a thinking-effort knob can take this, including
 * opencode, codex and cursor, which have no model ladder to route on. No
 * confidence floor either: the floor on the model side exists to protect a
 * *pin*, and under {@link AUTO_SENTINEL} there is no pin to protect.
 * An uncertain answer is still a better basis than a constant.
 */
function routeEffort(input: RouteSizingInput): ThinkingEffort | null {
  if (!isAutoSentinel(input.configuredEffort)) return null;
  // Clamped, not filtered: an agent that tops out below the answered tier
  // should get its strongest available tier rather than nothing, which is
  // what "as much thinking as this agent allows" means.
  return clampThinkingEffort(input.agent, EFFORT_TIERS[input.reasoningEffort]) ?? null;
}

/**
 * Resolve a launch override, or `null` when neither half applies.
 *
 * The two halves are decided independently and either can be absent — a PR
 * can be routed to a bigger model while the user keeps their pinned effort,
 * or sized to `max` thinking on an agent that has no model ladder at all.
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
