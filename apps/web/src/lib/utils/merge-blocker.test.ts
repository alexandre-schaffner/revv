import { describe, expect, test } from "bun:test";
import { isMergeStateSettling, mergeBlocker } from "./merge-blocker";

const clear = { reviewDecision: null, ciState: null } as const;

describe("mergeBlocker", () => {
  test("lets mergeable states through", () => {
    for (const state of ["CLEAN", "HAS_HOOKS", "UNSTABLE"]) {
      expect(mergeBlocker({ ...clear, mergeStateStatus: state })).toBeNull();
    }
  });

  test("names conflicts, a stale branch, and drafts", () => {
    expect(mergeBlocker({ ...clear, mergeStateStatus: "DIRTY" })).toContain("conflicts");
    expect(mergeBlocker({ ...clear, mergeStateStatus: "BEHIND" })).toContain("out of date");
    expect(mergeBlocker({ ...clear, mergeStateStatus: "DRAFT" })).toContain("Draft");
  });

  test("treats a still-computing state as blocked", () => {
    expect(mergeBlocker({ ...clear, mergeStateStatus: "unknown" })).not.toBeNull();
    expect(isMergeStateSettling("unknown")).toBe(true);
    expect(isMergeStateSettling("BLOCKED")).toBe(false);
  });

  test("explains BLOCKED from the review decision before CI", () => {
    expect(
      mergeBlocker({
        mergeStateStatus: "BLOCKED",
        reviewDecision: "review_required",
        ciState: "failure",
      }),
    ).toBe("An approving review is required");
    expect(
      mergeBlocker({ mergeStateStatus: "BLOCKED", reviewDecision: "approved", ciState: "failure" }),
    ).toBe("Required checks are failing");
    expect(
      mergeBlocker({ mergeStateStatus: "BLOCKED", reviewDecision: "approved", ciState: "pending" }),
    ).toBe("Required checks haven't finished");
    expect(
      mergeBlocker({ mergeStateStatus: "BLOCKED", reviewDecision: "approved", ciState: "success" }),
    ).toBe("Merging is blocked by branch protection");
  });
});
