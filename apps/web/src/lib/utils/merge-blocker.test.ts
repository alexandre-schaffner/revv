import { describe, expect, test } from "bun:test";
import { isMergeStateSettling, type MergeGate, mergeGate } from "./merge-blocker";

const clear = { reviewDecision: null, ciState: null, canBypassProtections: false } as const;

function reasonOf(gate: MergeGate): string | null {
  return gate.kind === "blocked" ? gate.reason : null;
}

describe("mergeGate", () => {
  test("lets mergeable states through", () => {
    for (const state of ["CLEAN", "HAS_HOOKS", "UNSTABLE"]) {
      expect(mergeGate({ ...clear, mergeStateStatus: state })).toEqual({ kind: "open" });
    }
  });

  test("names conflicts, a stale branch, and drafts", () => {
    expect(reasonOf(mergeGate({ ...clear, mergeStateStatus: "DIRTY" }))).toContain("conflicts");
    expect(reasonOf(mergeGate({ ...clear, mergeStateStatus: "BEHIND" }))).toContain("out of date");
    expect(reasonOf(mergeGate({ ...clear, mergeStateStatus: "DRAFT" }))).toContain("Draft");
  });

  test("treats a still-computing state as blocked", () => {
    expect(mergeGate({ ...clear, mergeStateStatus: "unknown" }).kind).toBe("blocked");
    expect(isMergeStateSettling("unknown")).toBe(true);
    expect(isMergeStateSettling("BLOCKED")).toBe(false);
  });

  test("explains BLOCKED from the review decision before CI", () => {
    expect(
      reasonOf(
        mergeGate({
          ...clear,
          mergeStateStatus: "BLOCKED",
          reviewDecision: "review_required",
          ciState: "failure",
        }),
      ),
    ).toBe("An approving review is required");
    expect(
      reasonOf(
        mergeGate({
          ...clear,
          mergeStateStatus: "BLOCKED",
          reviewDecision: "approved",
          ciState: "failure",
        }),
      ),
    ).toBe("Required checks are failing");
    expect(
      reasonOf(
        mergeGate({
          ...clear,
          mergeStateStatus: "BLOCKED",
          reviewDecision: "approved",
          ciState: "pending",
        }),
      ),
    ).toBe("Required checks haven't finished");
    expect(
      reasonOf(
        mergeGate({
          ...clear,
          mergeStateStatus: "BLOCKED",
          reviewDecision: "approved",
          ciState: "success",
        }),
      ),
    ).toBe("Merging is blocked by branch protection");
  });

  test("lets a viewer who can bypass protections merge a BLOCKED PR, naming the rule", () => {
    expect(
      mergeGate({
        mergeStateStatus: "BLOCKED",
        reviewDecision: "review_required",
        ciState: "success",
        canBypassProtections: true,
      }),
    ).toEqual({ kind: "bypass", rule: "An approving review is required" });
  });

  test("never bypasses conflicts, a draft, a stale branch, or an unsettled state", () => {
    for (const state of ["DIRTY", "DRAFT", "BEHIND", "UNKNOWN"]) {
      expect(
        mergeGate({ ...clear, canBypassProtections: true, mergeStateStatus: state }).kind,
      ).toBe("blocked");
    }
  });
});
