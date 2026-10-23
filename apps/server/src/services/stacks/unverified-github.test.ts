import { describe, expect, test } from "bun:test";
import type { GitHubStack, GitHubStackLayer } from "./map";
import { planStackRebase } from "./rebase-plan";
import { membershipAfterRetarget } from "./unverified-github";

function layer(position: number, over: Partial<GitHubStackLayer> = {}): GitHubStackLayer {
  return {
    nodeId: `N${position}`,
    position,
    number: 100 + position,
    title: `Layer ${position}`,
    url: "",
    headRef: `feat-${position}`,
    status: "not_ready",
    headSha: `h${position}`,
    baseRef: position === 1 ? "main" : `feat-${position - 1}`,
    mergeStateStatus: "BLOCKED",
    reviewDecision: null,
    viewerReview: null,
    checks: null,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    authorLogin: "a",
    mergedAt: null,
    autoMergeEnabled: false,
    isInMergeQueue: false,
    behindBy: 0,
    ...over,
  };
}

const stackOf = (layers: readonly GitHubStackLayer[], number = 7): GitHubStack => ({
  number,
  baseRefName: "main",
  layers,
  autoMergeAllowed: false,
  allowedMethods: ["squash"],
  viewerCanPush: true,
  fetchedAt: "2026-10-19T00:00:00Z",
});

describe("membershipAfterRetarget", () => {
  const before = stackOf([layer(1, { status: "merged" }), layer(2), layer(3)]);
  const planned = planStackRebase(before);
  const retarget = planned.ok ? planned.plan.retarget : null;

  test("the rebase retargets the layer above a merged bottom", () => {
    expect(retarget).toBe(102);
  });

  test("the retargeted layer still in its stack is no contradiction", () => {
    const after = stackOf([
      layer(1, { status: "merged" }),
      layer(2, { baseRef: "main" }),
      layer(3),
    ]);
    expect(membershipAfterRetarget(before, 102, after)).toBeNull();
  });

  test("the retargeted layer in no stack contradicts base-change-keeps-membership", () => {
    expect(membershipAfterRetarget(before, 102, null)).toEqual({
      behaviour: "base-change-keeps-membership",
      number: 102,
    });
  });

  test("the retargeted layer in another stack contradicts base-change-keeps-membership", () => {
    const elsewhere = stackOf([layer(2, { position: 1, baseRef: "main" })], 8);
    expect(membershipAfterRetarget(before, 102, elsewhere)).toEqual({
      behaviour: "base-change-keeps-membership",
      number: 102,
    });
  });

  test("a stack re-read without the retargeted layer contradicts base-change-keeps-membership", () => {
    const without = stackOf([layer(1, { status: "merged" }), layer(3, { baseRef: "main" })]);
    expect(membershipAfterRetarget(before, 102, without)).toEqual({
      behaviour: "base-change-keeps-membership",
      number: 102,
    });
  });
});
