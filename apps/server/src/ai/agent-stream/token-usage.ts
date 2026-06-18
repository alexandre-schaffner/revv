// ── Token-usage algebra ──────────────────────────────────────────────────────
//
// The provider-AGNOSTIC algebra over `WalkthroughTokenUsage`. Over the ACP
// transport, occupancy comes from the agent's `usage_update` frames (decoded in
// `acp-decoders.ts`); throughput fields are unavailable and stay zero. This
// module owns only the orchestrator-side accumulation: how a running total folds
// in each usage delta as a walkthrough job streams and auto-continues.
//
// Two distinct notions of "tokens" coexist on `WalkthroughTokenUsage`:
//
//   • Throughput (input/output/cache* fields) — cumulative counts of tokens
//     processed across the whole run. These ACCUMULATE: each generator (and
//     each auto-continuation) contributes more, so we sum them.
//
//   • Occupancy (`contextTokens` / `contextWindowTokens`) — a point-in-time
//     snapshot of how full the model's context window is RIGHT NOW. These are
//     NOT additive: `contextTokens` is last-write-wins (the newest call's
//     prompt+output is the current size; summing would be nonsense) and
//     `contextWindowTokens` is a fixed model property, so we keep the max seen.
//     A zero/absent occupancy field means "no information" and never clobbers a
//     previously-observed value.

import type { WalkthroughTokenUsage } from "@revv/shared";

/** Throughput and occupancy both at zero — the identity for accumulation. */
export const ZERO_TOKEN_USAGE: WalkthroughTokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  contextTokens: 0,
});

const isPositiveFinite = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Sum the throughput fields of `delta` into `acc`, leaving `acc`'s occupancy
 * fields untouched. Used both to commit a generator's totals and to compute a
 * live (uncommitted) preview while streaming.
 */
export function addThroughput(
  acc: WalkthroughTokenUsage,
  delta: WalkthroughTokenUsage,
): WalkthroughTokenUsage {
  return {
    inputTokens: acc.inputTokens + delta.inputTokens,
    outputTokens: acc.outputTokens + delta.outputTokens,
    cacheReadInputTokens: acc.cacheReadInputTokens + delta.cacheReadInputTokens,
    cacheCreationInputTokens: acc.cacheCreationInputTokens + delta.cacheCreationInputTokens,
    contextTokens: acc.contextTokens,
    ...(acc.contextWindowTokens !== undefined
      ? { contextWindowTokens: acc.contextWindowTokens }
      : {}),
  };
}

/**
 * Fold `delta`'s occupancy into `acc`, leaving throughput untouched.
 * `contextTokens` is last-write-wins; `contextWindowTokens` takes the max.
 * Zero/absent occupancy in `delta` is ignored, so a provider that never reports
 * it (or reports 0 = "unknown") can't reset a value an earlier call observed.
 */
export function mergeContextOccupancy(
  acc: WalkthroughTokenUsage,
  delta: WalkthroughTokenUsage,
): WalkthroughTokenUsage {
  const contextTokens = isPositiveFinite(delta.contextTokens)
    ? delta.contextTokens
    : acc.contextTokens;
  const contextWindowTokens = isPositiveFinite(delta.contextWindowTokens)
    ? Math.max(acc.contextWindowTokens ?? 0, delta.contextWindowTokens)
    : acc.contextWindowTokens;
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadInputTokens: acc.cacheReadInputTokens,
    cacheCreationInputTokens: acc.cacheCreationInputTokens,
    contextTokens,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}

/**
 * Commit a usage `delta` into `acc`: occupancy merged (point-in-time) and
 * throughput summed (cumulative). The result is a complete snapshot suitable
 * for broadcast and persistence.
 */
export function accumulateTokenUsage(
  acc: WalkthroughTokenUsage,
  delta: WalkthroughTokenUsage,
): WalkthroughTokenUsage {
  return addThroughput(mergeContextOccupancy(acc, delta), delta);
}
