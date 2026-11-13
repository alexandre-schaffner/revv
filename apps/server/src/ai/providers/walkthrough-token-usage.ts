// Over ACP, occupancy comes from the agent's `usage_update` frames (decoded in
// `acp-decoders.ts`); throughput fields are unavailable and stay zero.
//
// Throughput (input/output/cache*) counts tokens processed across the run and
// every auto-continuation, so it sums. Occupancy (`contextTokens` /
// `contextWindowTokens`) is a point-in-time snapshot of the context window, so
// it doesn't: `contextTokens` is last-write-wins and `contextWindowTokens` is a
// fixed model property, so the max seen wins. A zero/absent occupancy field
// means "no information" and never clobbers an observed value.

import type { WalkthroughTokenUsage } from "@revv/shared";

const isPositiveFinite = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

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

export function accumulateTokenUsage(
  acc: WalkthroughTokenUsage,
  delta: WalkthroughTokenUsage,
): WalkthroughTokenUsage {
  return addThroughput(mergeContextOccupancy(acc, delta), delta);
}
