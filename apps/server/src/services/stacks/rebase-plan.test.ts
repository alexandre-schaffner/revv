import { describe, expect, test } from "bun:test";
import type { GitHubStack, GitHubStackLayer } from "./map";
import { planStackRebase } from "./rebase-plan";

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

const stackOf = (layers: readonly GitHubStackLayer[]): GitHubStack => ({
  number: 7,
  baseRefName: "main",
  layers,
  autoMergeAllowed: false,
  allowedMethods: ["squash"],
  viewerCanPush: true,
  fetchedAt: "2026-10-19T00:00:00Z",
});

function planOf(stack: GitHubStack) {
  const result = planStackRebase(stack);
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}

describe("planStackRebase", () => {
  test("cascades bottom-up, each layer onto the one below", () => {
    const plan = planOf(stackOf([layer(1), layer(2), layer(3)]));
    expect(plan.steps).toEqual([
      { number: 101, headRef: "feat-1", tip: "h1", onto: { kind: "base" }, upstreams: [] },
      {
        number: 102,
        headRef: "feat-2",
        tip: "h2",
        onto: { kind: "layer", number: 101 },
        upstreams: ["h1"],
      },
      {
        number: 103,
        headRef: "feat-3",
        tip: "h3",
        onto: { kind: "layer", number: 102 },
        upstreams: ["h2"],
      },
    ]);
    expect(plan.retarget).toBeNull();
  });

  test("replays past a merged layer from its old head, onto the base", () => {
    const plan = planOf(stackOf([layer(1, { status: "merged" }), layer(2), layer(3)]));
    expect(plan.steps[0]).toMatchObject({ number: 102, onto: { kind: "base" }, upstreams: ["h1"] });
    expect(plan.steps[1]).toMatchObject({ onto: { kind: "layer", number: 102 } });
    // Still targeting the merged branch: point it at the stack base.
    expect(plan.retarget).toBe(102);
  });

  test("doesn't retarget a layer GitHub already moved onto the base", () => {
    const plan = planOf(
      stackOf([layer(1, { status: "merged" }), layer(2, { baseRef: "main" }), layer(3)]),
    );
    expect(plan.retarget).toBeNull();
  });

  test("refuses a closed layer with open layers on it, skips one on top", () => {
    const middle = planStackRebase(stackOf([layer(1), layer(2, { status: "closed" }), layer(3)]));
    expect(middle).toMatchObject({ ok: false });
    const top = planOf(stackOf([layer(1), layer(2), layer(3, { status: "closed" })]));
    expect(top.steps.map((s) => s.number)).toEqual([101, 102]);
  });

  test("refuses a layer in the merge queue, or with no head", () => {
    expect(planStackRebase(stackOf([layer(1, { isInMergeQueue: true }), layer(2)]))).toMatchObject({
      ok: false,
    });
    expect(planStackRebase(stackOf([layer(1), layer(2, { headSha: null })]))).toMatchObject({
      ok: false,
    });
  });

  test("refuses a stack with nothing open", () => {
    expect(
      planStackRebase(stackOf([layer(1, { status: "merged" }), layer(2, { status: "merged" })])),
    ).toMatchObject({ ok: false });
  });
});
