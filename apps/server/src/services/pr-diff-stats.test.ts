import { describe, expect, it } from "bun:test";
import { needsDiffStats } from "./pr-diff-stats";

describe("needsDiffStats", () => {
  it("does not re-fetch a genuinely empty PR once its head is watermarked", () => {
    expect(needsDiffStats({ headSha: "head-1" }, "head-1", "head-1")).toBe(false);
  });

  it("fetches a new PR and a changed head", () => {
    expect(needsDiffStats(undefined, undefined, "head-1")).toBe(true);
    expect(needsDiffStats({ headSha: "head-1" }, "head-1", "head-2")).toBe(true);
  });

  it("backfills a legacy row without a watermark", () => {
    expect(needsDiffStats({ headSha: "head-1" }, null, "head-1")).toBe(true);
  });
});
