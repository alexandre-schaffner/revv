import { describe, expect, it } from "bun:test";
import type { WalkthroughIssue } from "@revv/shared";
import { partitionBySignal } from "./walkthrough-issues";

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
