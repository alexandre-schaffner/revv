import { describe, expect, it } from "bun:test";
import { diffLineStats } from "./diff-stats";

describe("diffLineStats", () => {
  it("counts the lines an edit added and removed", () => {
    expect(diffLineStats({ path: "a.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" })).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("is zero for an edit that changed nothing, or an empty pair", () => {
    expect(diffLineStats({ path: "a.ts", oldText: "x\n", newText: "x\n" })).toEqual({
      additions: 0,
      deletions: 0,
    });
    expect(diffLineStats({ path: "", oldText: "", newText: "" })).toEqual({
      additions: 0,
      deletions: 0,
    });
  });
});
