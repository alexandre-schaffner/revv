import { describe, expect, it } from "bun:test";
import type { WalkthroughIssue } from "@revv/shared";
import {
  countBySeverity,
  outstandingItemsPhrase,
  partitionBySignal,
  sortBySeverity,
} from "./walkthrough-issues";

function issue(over: Partial<WalkthroughIssue> & { id: string }): WalkthroughIssue {
  return {
    severity: "warning",
    title: "t",
    description: "d",
    blockIds: [],
    ...over,
  };
}

describe("partitionBySignal", () => {
  it("shows everything when hiding is off", () => {
    const issues = [issue({ id: "a", lowSignal: true }), issue({ id: "b" })];
    const { shown, filtered } = partitionBySignal(issues, { hideLowSignal: false });
    expect(shown.map((i) => i.id)).toEqual(["a", "b"]);
    expect(filtered).toEqual([]);
  });

  it("never hides an unscored issue", () => {
    // Unscored rows (pre-feature, cache-imported, pass unreachable) degrade to visible.
    const issues = [issue({ id: "a" }), issue({ id: "b", advisoryScore: 0.9, lowSignal: false })];
    const { shown, filtered } = partitionBySignal(issues, { hideLowSignal: true });
    expect(shown.map((i) => i.id)).toEqual(["a", "b"]);
    expect(filtered).toEqual([]);
  });

  it("hides scored low-signal issues", () => {
    const issues = [
      issue({ id: "a", advisoryScore: 0.1, lowSignal: true }),
      issue({ id: "b", advisoryScore: 0.8, lowSignal: false }),
    ];
    const { shown, filtered } = partitionBySignal(issues, { hideLowSignal: true });
    expect(shown.map((i) => i.id)).toEqual(["b"]);
    expect(filtered.map((i) => i.id)).toEqual(["a"]);
  });

  it("never hides an issue already posted to GitHub", () => {
    // Dropping it would misrepresent what was sent.
    const issues = [
      issue({ id: "a", lowSignal: true, submittedAt: "2026-01-01T00:00:00Z" }),
      issue({ id: "b", lowSignal: true }),
    ];
    const { shown, filtered } = partitionBySignal(issues, { hideLowSignal: true });
    expect(shown.map((i) => i.id)).toEqual(["a"]);
    expect(filtered.map((i) => i.id)).toEqual(["b"]);
  });

  it("preserves relative order within each side", () => {
    const issues = [
      issue({ id: "a", lowSignal: true }),
      issue({ id: "b" }),
      issue({ id: "c", lowSignal: true }),
      issue({ id: "d" }),
    ];
    const { shown, filtered } = partitionBySignal(issues, { hideLowSignal: true });
    expect(shown.map((i) => i.id)).toEqual(["b", "d"]);
    expect(filtered.map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("sortBySeverity", () => {
  it("puts the most severe first and keeps arrival order within a severity", () => {
    const issues = [
      issue({ id: "w1" }),
      issue({ id: "i1", severity: "info" }),
      issue({ id: "c1", severity: "critical" }),
      issue({ id: "w2" }),
    ];
    expect(sortBySeverity(issues).map((i) => i.id)).toEqual(["c1", "w1", "w2", "i1"]);
    expect(countBySeverity(issues)).toEqual({ critical: 1, warning: 2, info: 1 });
  });
});

describe("outstandingItemsPhrase", () => {
  it("names what is still open, pluralised", () => {
    expect(outstandingItemsPhrase(2, 1)).toBe("2 walkthrough issues and 1 unresolved comment");
    expect(outstandingItemsPhrase(1, 0)).toBe("1 walkthrough issue");
    expect(outstandingItemsPhrase(0, 3)).toBe("3 unresolved comments");
  });
});
