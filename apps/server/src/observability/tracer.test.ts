import { expect, test } from "bun:test";
import { clearSpans, readSpans, recordSpan, summarizeSpans } from "./tracer";

test("manual spans pass through OTel into the ring exactly once, using epoch timestamps", () => {
  clearSpans();
  const startMs = performance.now();
  recordSpan(
    "Test.manual",
    startMs,
    10,
    { path: "/api/example" },
    { name: "TestError", message: "failed" },
  );
  const spans = readSpans({ name: "Test.manual" });
  expect(spans).toHaveLength(1);
  expect(spans[0]?.startMs).toBeCloseTo(performance.timeOrigin + startMs, 1);
  expect(spans[0]?.attrs.path).toBe("/api/example");
  expect(spans[0]?.error).toEqual({ name: "TestError", message: "failed" });
  expect(summarizeSpans()["Test.manual"]).toMatchObject({ count: 1, totalMs: 10, errorCount: 1 });
});
