import type { SamplingProfileStackTraces } from "bun:jsc";
import { expect, test } from "bun:test";
import { foldedStacks } from "./profile-format";

test("exports leaf-first JSC samples as aggregated outer-first Pyroscope stacks", () => {
  const frame = (name: string) => ({
    sourceID: 1,
    name,
    location: "",
    line: 12,
    column: 1,
    category: "Baseline",
    flags: 0,
    sourceURL: "/src/test.ts",
  });
  const frames = [frame("inner;injected\nline"), frame("outer")];
  const input: SamplingProfileStackTraces = {
    interval: 0.01,
    sources: [],
    traces: [
      { timestamp: 1, frames },
      { timestamp: 2, frames },
      { timestamp: 3, frames: [] },
    ],
  };
  expect(foldedStacks(input)).toBe(
    "outer (/src/test.ts:12);inner_injected_line (/src/test.ts:12) 2",
  );
});
