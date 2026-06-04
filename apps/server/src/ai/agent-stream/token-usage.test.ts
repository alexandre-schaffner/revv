import { describe, expect, it } from "bun:test";
import type { Usage } from "@openai/codex-sdk";
import { computeOpencodeAggregateTokens } from "../providers/mcp-walkthrough-opencode";
import { walkClaudeMessages } from "./claude-walker";
import { mapCodexUsage } from "./codex-walker";
import {
  accumulateTokenUsage,
  addThroughput,
  mergeContextOccupancy,
  ZERO_TOKEN_USAGE,
} from "./token-usage";

async function* stream(messages: readonly unknown[]) {
  for (const message of messages) {
    yield message;
  }
}

describe("provider context token usage", () => {
  it("uses Claude's latest assistant call for occupancy and result usage for throughput", async () => {
    const usage = await walkClaudeMessages(
      stream([
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 1,
            },
          },
        },
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 20,
              output_tokens: 3,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 2,
            },
          },
        },
        {
          type: "result",
          usage: {
            input_tokens: 100,
            output_tokens: 30,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
          },
          modelUsage: [{ contextWindow: 200_000 }, { contextWindow: 1_000_000 }],
        },
      ]),
      () => {},
    );

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 10,
      contextTokens: 30,
      contextWindowTokens: 1_000_000,
    });
  });

  it("includes Codex's separately-reported cached input in occupancy", () => {
    const codexUsage = {
      input_tokens: 1_000,
      cached_input_tokens: 400,
      output_tokens: 200,
      reasoning_output_tokens: 50,
    } satisfies Usage;

    expect(mapCodexUsage(codexUsage)).toEqual({
      inputTokens: 1_000,
      outputTokens: 250,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 0,
      // Throughput keeps cached input broken out (not folded into inputTokens),
      // but occupancy is the WHOLE prompt — so the 400 cached tokens are added
      // back: 1000 + 400 + 200 + 50.
      contextTokens: 1_650,
    });
  });

  it("maps opencode throughput as sums while occupancy uses the latest call", () => {
    const snapshots = new Map([
      [
        "message-1",
        {
          input: 100,
          output: 10,
          reasoning: 2,
          cacheRead: 30,
          cacheWrite: 5,
        },
      ],
      [
        "message-2",
        {
          input: 150,
          output: 20,
          reasoning: 4,
          cacheRead: 45,
          cacheWrite: 7,
        },
      ],
    ]);

    expect(computeOpencodeAggregateTokens(snapshots, ["message-1", "message-2"])).toEqual({
      inputTokens: 150,
      outputTokens: 36,
      cacheReadInputTokens: 45,
      cacheCreationInputTokens: 12,
      contextTokens: 226,
    });
  });
});

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
