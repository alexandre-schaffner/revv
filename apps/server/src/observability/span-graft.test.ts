import { beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  anchorOfCurrentSpan,
  currentTraceAnchor,
  graftedSpan,
  publishTraceAnchor,
} from "./span-graft";
import { clearSpans, readSpans, TracingLive } from "./tracer";

describe("trace anchors", () => {
  test("publish/restore nests and unwinds", () => {
    const outer = { traceId: "a".repeat(32), spanId: "1".repeat(16) };
    const inner = { traceId: "a".repeat(32), spanId: "2".repeat(16) };

    expect(currentTraceAnchor("job-1")).toBeNull();
    const restoreOuter = publishTraceAnchor("job-1", outer);
    expect(currentTraceAnchor("job-1")).toEqual(outer);

    const restoreInner = publishTraceAnchor("job-1", inner);
    expect(currentTraceAnchor("job-1")).toEqual(inner);

    restoreInner();
    expect(currentTraceAnchor("job-1")).toEqual(outer);
    restoreOuter();
    expect(currentTraceAnchor("job-1")).toBeNull();
  });

  test("keys are independent, and a null key never resolves", () => {
    const restore = publishTraceAnchor("job-a", {
      traceId: "b".repeat(32),
      spanId: "3".repeat(16),
    });
    expect(currentTraceAnchor("job-b")).toBeNull();
    expect(currentTraceAnchor(null)).toBeNull();
    expect(currentTraceAnchor(undefined)).toBeNull();
    restore();
  });
});

describe("graftedSpan", () => {
  beforeEach(() => {
    clearSpans();
  });

  /**
   * The regression this file exists for.
   *
   * `graftedSpan` reaches OTel through the global API (`trace.getTracer`),
   * because the code that calls it — MCP tool handlers, ACP session listeners —
   * has no Effect fiber to borrow a tracer from. If the tracer provider is not
   * registered globally, that call silently returns a non-recording span and
   * every one of those spans vanishes. Nothing throws; the dashboard just shows
   * a four-minute generation with nothing inside it.
   */
  test("a globally-created span reaches the exporter inside the Effect trace", async () => {
    let anchorSpanId = "";

    await Effect.runPromise(
      Effect.provide(
        Effect.withSpan("Test.parent")(
          Effect.gen(function* () {
            const anchor = yield* anchorOfCurrentSpan;
            expect(anchor).not.toBeNull();
            if (!anchor) return;
            anchorSpanId = anchor.spanId;

            const restore = publishTraceAnchor("wt-1", anchor);
            const span = graftedSpan("wt-1", "Mcp.set_overview", {
              attributes: { mcp_tool: "set_overview" },
            });
            yield* Effect.sleep("10 millis");
            span.end();
            restore();
          }),
        ),
        TracingLive,
      ),
    );

    const spans = readSpans();
    const grafted = spans.find((s) => s.name === "Mcp.set_overview");
    const parent = spans.find((s) => s.name === "Test.parent");

    expect(grafted).toBeDefined();
    expect(parent).toBeDefined();
    expect(grafted?.traceId).toBe(parent?.traceId ?? "");
    expect(grafted?.parentSpanId).toBe(anchorSpanId);
    expect(grafted?.attrs.mcp_tool).toBe("set_overview");
    expect(grafted?.durationMs ?? 0).toBeGreaterThan(0);
  });

  test("without an anchor the span is still recorded, just unparented", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.sync(() => {
          graftedSpan("no-such-job", "Mcp.orphan", {}).end();
        }),
        TracingLive,
      ),
    );

    const orphan = readSpans().find((s) => s.name === "Mcp.orphan");
    expect(orphan).toBeDefined();
    expect(orphan?.parentSpanId).toBeNull();
  });
});
