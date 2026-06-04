import { describe, expect, it } from "bun:test";
import type { Usage } from "@openai/codex-sdk";
import { computeOpencodeAggregateTokens } from "../providers/mcp-walkthrough-opencode";
import { walkClaudeMessages } from "./claude-walker";
import { mapCodexUsage } from "./codex-walker";

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

  it("maps Codex occupancy without double-counting cached input", () => {
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
      contextTokens: 1_250,
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
