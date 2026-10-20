import { describe, expect, test } from "bun:test";
import type { StackMergeRunLayer } from "@revv/shared";
import type { GitHubStack, GitHubStackLayer } from "./map";
import {
  AUTO_MERGE_WAIT_MS,
  defaultThrough,
  initialRunLayers,
  layerReadiness,
  nextStep,
  planLayers,
  RETARGET_WAIT_MS,
  reconcileLayers,
  type StackRead,
  startRefusal,
  withinBudget,
} from "./merge-plan";

function layer(position: number, over: Partial<GitHubStackLayer> = {}): GitHubStackLayer {
  return {
    nodeId: `N${position}`,
    position,
    number: 100 + position,
    title: `Layer ${position}`,
    url: "",
    headRef: `feat-${position}`,
    status: "ready",
    headSha: `h${position}`,
    baseRef: position === 1 ? "main" : `feat-${position - 1}`,
    mergeStateStatus: position === 1 ? "CLEAN" : "BLOCKED",
    reviewDecision: "approved",
    viewerReview: null,
    checks: "success",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    authorLogin: "a",
    mergedAt: null,
    autoMergeEnabled: false,
    isInMergeQueue: false,
    behindBy: null,
    ...over,
  };
}

function stackOf(
  layers: readonly GitHubStackLayer[],
  over: Partial<GitHubStack> = {},
): GitHubStack {
  return {
    number: 7,
    baseRefName: "main",
    layers,
    autoMergeAllowed: false,
    allowedMethods: ["merge", "squash"],
    viewerCanPush: true,
    fetchedAt: "2026-10-16T00:00:00Z",
    ...over,
  };
}

const readOf = (stack: GitHubStack, mergedOutside: number[] = []): StackRead => ({
  stack,
  mergedOutside: new Set(mergedOutside),
});

function runLayer(position: number, over: Partial<StackMergeRunLayer> = {}): StackMergeRunLayer {
  return {
    position,
    number: 100 + position,
    expectedHeadSha: `h${position}`,
    state: "pending",
    message: null,
    ...over,
  };
}

describe("layerReadiness", () => {
  const stack = stackOf([layer(1), layer(2)]);

  test("merged, closed and draft layers", () => {
    expect(layerReadiness(layer(1, { status: "merged" }), stack, "driven").readiness).toBe(
      "merged",
    );
    expect(layerReadiness(layer(1, { status: "closed" }), stack, "driven")).toEqual({
      readiness: "blocked",
      reasons: ["Closed without merging"],
    });
    expect(layerReadiness(layer(1, { status: "draft" }), stack, "driven").reasons).toEqual([
      "Still a draft",
    ]);
  });

  test("GitHub's mergeable states are ready", () => {
    for (const s of ["CLEAN", "HAS_HOOKS", "UNSTABLE"]) {
      expect(layerReadiness(layer(1, { mergeStateStatus: s }), stack, "driven").readiness).toBe(
        "ready",
      );
    }
  });

  test("UNSTABLE is ready even with a failing non-required check", () => {
    const l = layer(1, { mergeStateStatus: "UNSTABLE", checks: "failure" });
    expect(layerReadiness(l, stack, "driven").readiness).toBe("ready");
  });

  test("conflicts and a stale base name the base", () => {
    expect(
      layerReadiness(layer(1, { mergeStateStatus: "DIRTY" }), stack, "driven").reasons,
    ).toEqual(["Conflicts with main"]);
    expect(
      layerReadiness(
        layer(2, { mergeStateStatus: "BEHIND" }),
        stackOf([], { viewerCanPush: false }),
        "driven",
      ),
    ).toEqual({ readiness: "blocked", reasons: ["Behind feat-1"] });
  });

  test("a layer behind its base is ready when Revv can rebase it, on its own merits", () => {
    expect(layerReadiness(layer(1, { behindBy: 4 }), stack, "driven")).toEqual({
      readiness: "ready",
      reasons: ["Behind main: Revv rebases it first"],
    });
    expect(
      layerReadiness(
        layer(1, { mergeStateStatus: "BEHIND", reviewDecision: "review_required" }),
        stack,
        "driven",
      ),
    ).toEqual({ readiness: "blocked", reasons: ["Review required"] });
  });

  test("an upper layer BLOCKED only by the layers below is ready", () => {
    expect(layerReadiness(layer(2), stack, "driven")).toEqual({ readiness: "ready", reasons: [] });
  });

  test("an upper layer is still held to its own reviews and checks", () => {
    expect(
      layerReadiness(layer(2, { reviewDecision: "changes_requested" }), stack, "driven").reasons,
    ).toEqual(["Changes requested"]);
    expect(
      layerReadiness(
        layer(2, { reviewDecision: "review_required", checks: "failure" }),
        stack,
        "driven",
      ).reasons,
    ).toEqual(["Review required", "Checks failing"]);
  });

  test("BLOCKED on the stack base with nothing else to show is branch protection", () => {
    const l = layer(1, { mergeStateStatus: "BLOCKED" });
    expect(layerReadiness(l, stack, "driven").reasons).toEqual(["Blocked by branch protection"]);
  });

  test("running checks block a driven merge but not an auto one", () => {
    const l = layer(1, { mergeStateStatus: "BLOCKED", checks: "pending" });
    expect(layerReadiness(l, stack, "driven")).toEqual({
      readiness: "blocked",
      reasons: ["Checks still running"],
    });
    const auto = layerReadiness(l, stack, "auto");
    expect(auto.readiness).toBe("ready");
    expect(auto.reasons).toHaveLength(1);
  });

  test("UNKNOWN is left for the run to wait out", () => {
    const l = layer(1, { mergeStateStatus: "UNKNOWN" });
    expect(layerReadiness(l, stack, "driven").readiness).toBe("ready");
  });
});

describe("planLayers / defaultThrough", () => {
  test("reaches through contiguous ready layers from the lowest open one", () => {
    const stack = stackOf([
      layer(1, { status: "merged" }),
      layer(2, { baseRef: "main", mergeStateStatus: "CLEAN" }),
      layer(3),
      layer(4, { reviewDecision: "review_required" }),
      layer(5),
    ]);
    const layers = planLayers(stack, new Map([[102, "pr-2"]]));
    expect(layers.map((l) => l.readiness)).toEqual([
      "merged",
      "ready",
      "ready",
      "blocked",
      "ready",
    ]);
    expect(layers[1]?.prId).toBe("pr-2");
    expect(layers[0]?.prId).toBeNull();
    expect(defaultThrough(layers)).toBe(3);
  });

  test("null when the lowest open layer can't merge, or nothing is open", () => {
    const blocked = planLayers(stackOf([layer(1, { status: "draft" }), layer(2)]), new Map());
    expect(defaultThrough(blocked)).toBeNull();
    const done = planLayers(
      stackOf([layer(1, { status: "merged" }), layer(2, { status: "merged" })]),
      new Map(),
    );
    expect(defaultThrough(done)).toBeNull();
  });

  test("auto mode reads from the repo setting", () => {
    const stack = stackOf(
      [layer(1, { mergeStateStatus: "BLOCKED", checks: "pending" }), layer(2)],
      {
        autoMergeAllowed: true,
      },
    );
    expect(defaultThrough(planLayers(stack, new Map()))).toBe(2);
  });
});

describe("startRefusal", () => {
  const stack = stackOf([layer(1), layer(2), layer(3, { status: "draft" })]);
  const layers = planLayers(stack, new Map());
  const heads = { "101": "h1", "102": "h2", "103": "h3" };

  test("accepts a ready range with matching heads", () => {
    expect(
      startRefusal(stack, layers, { throughPosition: 2, method: "merge", expectedHeads: heads }),
    ).toBeNull();
  });

  test("refuses a method the repo forbids", () => {
    expect(
      startRefusal(stack, layers, { throughPosition: 1, method: "rebase", expectedHeads: heads })
        ?.message,
    ).toContain("rebase");
  });

  test("an empty method list is a host too old to say", () => {
    const old = stackOf(stack.layers, { allowedMethods: [] });
    expect(
      startRefusal(old, layers, { throughPosition: 1, method: "rebase", expectedHeads: heads }),
    ).toBeNull();
  });

  test("refuses a range with a blocked layer", () => {
    expect(
      startRefusal(stack, layers, { throughPosition: 3, method: "merge", expectedHeads: heads }),
    ).toEqual({ message: "#103 can't merge yet: Still a draft", reason: "invalid" });
  });

  test("refuses a layer that moved since the user looked", () => {
    expect(
      startRefusal(stack, layers, {
        throughPosition: 2,
        method: "merge",
        expectedHeads: { "101": "h1", "102": "old" },
      }),
    ).toEqual({
      message: "#102 got new commits since you opened this — review them first",
      reason: "conflict",
    });
    expect(
      startRefusal(stack, layers, { throughPosition: 2, method: "merge", expectedHeads: {} })
        ?.message,
    ).toContain("#101");
  });

  test("refuses a missing layer and an all-merged range", () => {
    expect(
      startRefusal(stack, layers, { throughPosition: 9, method: "merge", expectedHeads: heads })
        ?.message,
    ).toContain("no layer 9");
    const merged = stackOf([layer(1, { status: "merged" }), layer(2)]);
    expect(
      startRefusal(merged, planLayers(merged, new Map()), {
        throughPosition: 1,
        method: "merge",
        expectedHeads: heads,
      })?.message,
    ).toContain("already merged");
  });

  test("initialRunLayers keeps merged layers merged", () => {
    const merged = stackOf([layer(1, { status: "merged" }), layer(2), layer(3)]);
    expect(initialRunLayers(planLayers(merged, new Map()), 2).map((l) => l.state)).toEqual([
      "merged",
      "pending",
    ]);
  });
});

describe("nextStep", () => {
  const driven = (layers: StackMergeRunLayer[]) => ({ mode: "driven" as const, layers });

  test("merges a clean bottom layer pinned to the confirmed head", () => {
    const read = readOf(stackOf([layer(1), layer(2)]));
    expect(nextStep(driven([runLayer(1), runLayer(2)]), read)).toEqual({
      kind: "merge",
      number: 101,
      sha: "h1",
    });
  });

  test("complete when every run layer has merged", () => {
    const read = readOf(stackOf([layer(1, { status: "merged" }), layer(2, { status: "merged" })]));
    expect(nextStep(driven([runLayer(1), runLayer(2)]), read).kind).toBe("complete");
  });

  test("a layer the stack stopped listing but GitHub reports merged counts as merged", () => {
    const read = readOf(stackOf([layer(2, { baseRef: "main", mergeStateStatus: "CLEAN" })]), [101]);
    expect(nextStep(driven([runLayer(1), runLayer(2)]), read)).toEqual({
      kind: "merge",
      number: 102,
      sha: "h2",
    });
  });

  test("a layer missing outright stops the run", () => {
    const read = readOf(stackOf([layer(2)]));
    expect(nextStep(driven([runLayer(1)]), read)).toMatchObject({ kind: "fail", number: 101 });
  });

  test("a moved head stops the run", () => {
    const read = readOf(stackOf([layer(1, { headSha: "new" })]));
    expect(nextStep(driven([runLayer(1)]), read)).toEqual({
      kind: "fail",
      number: 101,
      message: "#101 got new commits after you confirmed — review them first",
    });
  });

  test("waits for GitHub to retarget the next layer", () => {
    const read = readOf(stackOf([layer(1, { status: "merged" }), layer(2)]));
    expect(nextStep(driven([runLayer(1, { state: "merged" }), runLayer(2)]), read)).toEqual({
      kind: "wait",
      number: 102,
      reason: "retarget",
    });
  });

  test("waits out UNKNOWN, rebases a layer behind its base once, then stops", () => {
    const at = (s: string, over: Partial<GitHubStackLayer> = {}) =>
      readOf(stackOf([layer(1, { mergeStateStatus: s, ...over })]));
    expect(nextStep(driven([runLayer(1)]), at("UNKNOWN"))).toMatchObject({
      reason: "mergeability",
    });
    expect(nextStep(driven([runLayer(1)]), at("DIRTY"))).toEqual({ kind: "rebase", number: 101 });
    expect(nextStep(driven([runLayer(1)]), at("BEHIND"))).toEqual({ kind: "rebase", number: 101 });
    // CLEAN, but GitHub stacks only merge a linear history.
    expect(nextStep(driven([runLayer(1)]), at("CLEAN", { behindBy: 2 }))).toEqual({
      kind: "rebase",
      number: 101,
    });

    const rebased = runLayer(1, { expectedHeadSha: "h1r", rebasedFrom: "h1" });
    expect(nextStep(driven([rebased]), at("DIRTY", { headSha: "h1r" }))).toEqual({
      kind: "fail",
      number: 101,
      message: "#101 needs a rebase onto main",
    });
    // GitHub still showing the head the run rebased away from is catching up.
    expect(nextStep(driven([rebased]), at("CLEAN"))).toMatchObject({
      kind: "wait",
      reason: "mergeability",
    });

    const noPush = readOf(
      stackOf([layer(1, { mergeStateStatus: "BEHIND" })], { viewerCanPush: false }),
    );
    expect(nextStep(driven([runLayer(1)]), noPush)).toMatchObject({ kind: "fail" });
  });

  test("running checks: driven waits, auto hands over, then waits on GitHub", () => {
    const read = readOf(stackOf([layer(1, { mergeStateStatus: "BLOCKED", checks: "pending" })]));
    expect(nextStep(driven([runLayer(1)]), read)).toMatchObject({ kind: "wait", reason: "checks" });
    expect(nextStep({ mode: "auto", layers: [runLayer(1)] }, read)).toEqual({
      kind: "auto_merge",
      number: 101,
      nodeId: "N1",
      sha: "h1",
    });
    // GitHub's read can lag the mutation; never enable twice.
    expect(
      nextStep({ mode: "auto", layers: [runLayer(1, { state: "auto_merge" })] }, read),
    ).toEqual({ kind: "wait", number: 101, reason: "auto_merge" });
  });

  test("lost reviews and failing checks stop the run", () => {
    const read = readOf(
      stackOf([layer(1, { mergeStateStatus: "BLOCKED", reviewDecision: "review_required" })]),
    );
    expect(nextStep(driven([runLayer(1)]), read)).toEqual({
      kind: "fail",
      number: 101,
      message: "#101: review required",
    });
  });

  test("an unexplained BLOCKED gets a grace period", () => {
    const read = readOf(stackOf([layer(1, { mergeStateStatus: "BLOCKED" })]));
    expect(nextStep(driven([runLayer(1)]), read)).toMatchObject({ reason: "protection" });
  });
});

describe("withinBudget", () => {
  test("a retarget wait past its budget becomes a PATCH to the stack base", () => {
    const wait = { kind: "wait", number: 102, reason: "retarget" } as const;
    expect(withinBudget(wait, RETARGET_WAIT_MS - 1, "main")).toBe(wait);
    expect(withinBudget(wait, RETARGET_WAIT_MS, "main")).toEqual({
      kind: "retarget",
      number: 102,
      base: "main",
    });
  });

  test("an auto-merge watch past its budget stops with a Continue", () => {
    const wait = { kind: "wait", number: 101, reason: "auto_merge" } as const;
    expect(withinBudget(wait, AUTO_MERGE_WAIT_MS, "main")).toMatchObject({ kind: "fail" });
  });
});

describe("reconcileLayers", () => {
  test("marks what GitHub merged, from the stack or outside it", () => {
    const read = readOf(stackOf([layer(1, { status: "merged" }), layer(2)]), [103]);
    expect(
      reconcileLayers([runLayer(1), runLayer(2), runLayer(3)], read).map((l) => l.state),
    ).toEqual(["merged", "pending", "merged"]);
  });
});
