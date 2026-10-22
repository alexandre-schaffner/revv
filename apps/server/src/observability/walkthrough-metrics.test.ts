import { expect, test } from "bun:test";
import { Effect } from "effect";
import { readSpans, TracingLive } from "./tracer";
import {
  recordWalkthroughToken,
  startWalkthroughPrompt,
  withContentWriteMetrics,
  withWalkthroughMetrics,
} from "./walkthrough-metrics";

test("counts successful MCP calls once and records only nonempty agent text after prompting", async () => {
  let emitted = 0;
  const write = withContentWriteMetrics(
    async (_ctx: { walkthroughId: string }, isError: boolean) => {
      emitted += 3; // One tool can emit both content and phase events.
      return { isError };
    },
  );
  await Effect.runPromise(
    Effect.promise(async () => {
      const ctx = { walkthroughId: "metrics-test" };
      recordWalkthroughToken(ctx.walkthroughId, "before the prompt");
      await write(ctx, false);
      await write(ctx, true);
      const thrown = withContentWriteMetrics(
        async (_ctx: typeof ctx): Promise<{ isError: boolean }> => {
          throw new Error("tool failed");
        },
      );
      await expect(thrown(ctx, undefined)).rejects.toThrow("tool failed");
      startWalkthroughPrompt(ctx.walkthroughId);
      recordWalkthroughToken(ctx.walkthroughId, "");
      await Bun.sleep(10);
      recordWalkthroughToken(ctx.walkthroughId, "first token");
      recordWalkthroughToken(ctx.walkthroughId, "later token");
      await write(ctx, false);
    }).pipe(
      withWalkthroughMetrics("metrics-test"),
      Effect.withSpan("Test.metrics"),
      Effect.provide(TracingLive),
    ),
  );
  const span = readSpans({ name: "Test.metrics" }).at(-1);
  expect(emitted).toBe(9);
  expect(span?.attrs.tool_call_count).toBe(2);
  expect(span?.attrs.ttft_ms).toBeGreaterThanOrEqual(5);
});

test("cleans metrics after failure and does not invent TTFT for a silent agent", async () => {
  const write = withContentWriteMetrics(async (_ctx: { walkthroughId: string }) => ({
    isError: false,
  }));
  await Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        await write({ walkthroughId: "failed-metrics" }, undefined);
        throw new Error("generation failed");
      },
      catch: (error) => error,
    }).pipe(
      withWalkthroughMetrics("failed-metrics"),
      Effect.withSpan("Test.failedMetrics"),
      Effect.ignore,
      Effect.provide(TracingLive),
    ),
  );
  await write({ walkthroughId: "failed-metrics" }, undefined);
  await Effect.runPromise(
    Effect.sync(() => {
      startWalkthroughPrompt("failed-metrics");
      recordWalkthroughToken("failed-metrics", "");
    }).pipe(
      withWalkthroughMetrics("failed-metrics"),
      Effect.withSpan("Test.silentMetrics"),
      Effect.provide(TracingLive),
    ),
  );
  const failed = readSpans({ name: "Test.failedMetrics" }).at(-1);
  const silent = readSpans({ name: "Test.silentMetrics" }).at(-1);
  expect(failed?.attrs.tool_call_count).toBe(1);
  expect(silent?.attrs.tool_call_count).toBe(0);
  expect(silent?.attrs.ttft_ms).toBeUndefined();
});
