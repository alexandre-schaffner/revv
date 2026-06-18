import { describe, expect, it } from "bun:test";
import {
  accumulateTokenUsage,
  addThroughput,
  mergeContextOccupancy,
  ZERO_TOKEN_USAGE,
} from "./token-usage";

describe("token-usage accumulation algebra", () => {
  it("sums throughput but takes the latest occupancy and max window", () => {
    const first = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 5,
      contextTokens: 150,
      contextWindowTokens: 200_000,
    };
    const second = {
      inputTokens: 200,
      outputTokens: 40,
      cacheReadInputTokens: 60,
      cacheCreationInputTokens: 10,
      contextTokens: 300,
      contextWindowTokens: 1_000_000,
    };

    const afterFirst = accumulateTokenUsage(ZERO_TOKEN_USAGE, first);
    const afterSecond = accumulateTokenUsage(afterFirst, second);

    expect(afterSecond).toEqual({
      // Throughput accumulates across both deltas.
      inputTokens: 300,
      outputTokens: 60,
      cacheReadInputTokens: 90,
      cacheCreationInputTokens: 15,
      // Occupancy is point-in-time: the latest delta wins.
      contextTokens: 300,
      // Window is a fixed model property: keep the largest seen.
      contextWindowTokens: 1_000_000,
    });
  });

  it("treats zero/absent occupancy as 'no info' and never clobbers a known value", () => {
    const known = mergeContextOccupancy(ZERO_TOKEN_USAGE, {
      ...ZERO_TOKEN_USAGE,
      contextTokens: 500,
      contextWindowTokens: 200_000,
    });
    // A later delta with no occupancy (e.g. a codex/opencode `usage` event that
    // reports throughput only) must leave the previously-observed occupancy.
    const merged = mergeContextOccupancy(known, ZERO_TOKEN_USAGE);
    expect(merged.contextTokens).toBe(500);
    expect(merged.contextWindowTokens).toBe(200_000);
  });

  it("addThroughput previews totals without touching occupancy", () => {
    const acc = {
      ...ZERO_TOKEN_USAGE,
      inputTokens: 10,
      contextTokens: 42,
      contextWindowTokens: 200_000,
    };
    const preview = addThroughput(acc, { ...ZERO_TOKEN_USAGE, inputTokens: 5, contextTokens: 999 });
    expect(preview.inputTokens).toBe(15);
    // Occupancy is preserved from the accumulator, not the delta.
    expect(preview.contextTokens).toBe(42);
    expect(preview.contextWindowTokens).toBe(200_000);
  });
});
