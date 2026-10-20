import { describe, expect, it } from "bun:test";
import type { StackLayer, StackLayerReview } from "@revv/shared";
import { planStackReview } from "./StackReview";

function layer(
  position: number,
  over: Partial<Pick<StackLayer, "status" | "prId" | "headSha" | "review">> = {},
): StackLayer {
  return {
    position,
    number: 100 + position,
    title: `Layer ${position}`,
    url: "",
    headRef: `layer-${position}`,
    status: "ready",
    headSha: `head-${position}`,
    baseRef: "main",
    mergeStateStatus: null,
    reviewDecision: null,
    viewerReview: null,
    checks: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    authorLogin: null,
    mergedAt: null,
    autoMergeEnabled: false,
    isInMergeQueue: false,
    behindBy: null,
    prId: `repo:${100 + position}`,
    review: { kind: "none" },
    restack: { kind: "unknown" },
    ...over,
  };
}

const complete = (reviewedHeadSha: string): StackLayerReview => ({
  kind: "complete",
  walkthroughId: `wt-${reviewedHeadSha}`,
  riskLevel: "low",
  openIssues: 0,
  criticalIssues: 0,
  takeaway: null,
  reviewedHeadSha,
  carried: false,
});

describe("planStackReview", () => {
  const stack = [
    layer(4, { review: complete("head-4") }),
    layer(1, { status: "merged" }),
    layer(3, { review: { kind: "generating", walkthroughId: "wt-3" } }),
    layer(2, { review: complete("stale-head") }),
    layer(5, { prId: null }),
    layer(6, { status: "closed" }),
    layer(7, { review: { kind: "error", walkthroughId: "wt-7" } }),
  ];

  it("remaining: skips current and generating reviews, keeps stale and errored ones", () => {
    const plan = planStackReview(stack, "remaining");
    expect(plan.queue.map((l) => l.number)).toEqual([102, 107]);
    expect(plan.watching).toEqual(["wt-3"]);
    expect(plan.untracked).toEqual([105]);
  });

  it("all: every open tracked layer, bottom-up", () => {
    const plan = planStackReview(stack, "all");
    expect(plan.queue.map((l) => l.number)).toEqual([102, 103, 104, 107]);
    expect(plan.watching).toEqual([]);
    expect(plan.untracked).toEqual([105]);
  });
});
