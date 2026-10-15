import { Effect } from "effect";

interface Metrics {
  contentWrites: number;
  promptStartedAt: number | null;
  ttftMs: number | null;
}

// Diagnostic cache only. Each generation owns and removes its entry, including
// on interruption; no journal or lifecycle decisions depend on these counters.
const active = new Map<string, Metrics>();

export function startWalkthroughPrompt(id: string): void {
  const metrics = active.get(id);
  if (metrics && metrics.promptStartedAt === null) metrics.promptStartedAt = performance.now();
}

export function recordWalkthroughToken(id: string, text: string): void {
  const metrics = active.get(id);
  if (metrics && text.length > 0 && metrics.promptStartedAt !== null && metrics.ttftMs === null) {
    metrics.ttftMs = performance.now() - metrics.promptStartedAt;
  }
}

/** Wrap mutating MCP handlers, counting successful calls once regardless of
 * how many content/phase events they emit. Reads and the completion gate stay
 * unwrapped. Successful idempotent replays count as calls, not distinct rows. */
export function withContentWriteMetrics<
  Ctx extends { walkthroughId: string },
  Input,
  Result extends { isError?: boolean },
>(
  handler: (ctx: Ctx, input: Input) => Promise<Result>,
): (ctx: Ctx, input: Input) => Promise<Result> {
  return async (ctx, input) => {
    const metrics = active.get(ctx.walkthroughId);
    const result = await handler(ctx, input);
    if (metrics && !result.isError) metrics.contentWrites++;
    return result;
  };
}

/** Apply inside the generation span so its final attributes include writes
 * made by HTTP callbacks as well as output arriving on the ACP connection. */
export const withWalkthroughMetrics =
  (id: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const metrics: Metrics = { contentWrites: 0, promptStartedAt: null, ttftMs: null };
        active.set(id, metrics);
        return metrics;
      }),
      () => effect,
      (metrics) =>
        Effect.gen(function* () {
          if (active.get(id) === metrics) active.delete(id);
          yield* Effect.annotateCurrentSpan("tool_call_count", metrics.contentWrites);
          if (metrics.ttftMs !== null) yield* Effect.annotateCurrentSpan("ttft_ms", metrics.ttftMs);
        }),
    );
