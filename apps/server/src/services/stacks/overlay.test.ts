import { describe, expect, test } from "bun:test";
import { fingerprintFiles } from "./fingerprint";
import type { GitHubStackLayer } from "./map";
import {
  fileOverlaps,
  restackVerdict,
  type TrackedLayer,
  takeawayOf,
  type WalkthroughFact,
} from "./overlay";

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
    mergeStateStatus: "CLEAN",
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
    behindBy: null,
    ...over,
  };
}

const file = { filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" };
const files = [file];

function fact(over: Partial<WalkthroughFact> = {}): WalkthroughFact {
  return {
    id: "w1",
    status: "complete",
    prHeadSha: "h2",
    riskLevel: "low",
    summary: "Adds the thing.",
    openIssues: 0,
    criticalIssues: 0,
    stackContext: {
      number: 7,
      baseRefName: "main",
      position: 2,
      layers: [
        { position: 1, number: 101, title: "", headSha: "h1", baseRef: "main", status: "ready" },
        { position: 2, number: 102, title: "", headSha: "h2", baseRef: "feat-1", status: "ready" },
      ],
      capturedAt: "",
    },
    fingerprint: fingerprintFiles(files),
    carried: false,
    ...over,
  };
}

function tracked(f: WalkthroughFact | null, current = fingerprintFiles(files)): TrackedLayer {
  return {
    prId: "p2",
    currentFingerprint: current,
    files: files.map((x) => x.filename),
    current: f,
    latestComplete: f,
  };
}

/** The layer under review in these two-layer stacks. */
function second(layers: GitHubStackLayer[]): GitHubStackLayer {
  const layer = layers[1];
  if (!layer) throw new Error("fixture stack needs two layers");
  return layer;
}

describe("restackVerdict", () => {
  const stack = [layer(1), layer(2)];

  test("unreviewed is unknown", () => {
    expect(restackVerdict(second(stack), stack, undefined).kind).toBe("unknown");
  });

  test("reviewed at this head with nothing moved is current", () => {
    expect(restackVerdict(second(stack), stack, tracked(fact())).kind).toBe("current");
  });

  test("a lower layer that moved after the review is below-moved", () => {
    const moved = [layer(1, { headSha: "h1b" }), layer(2)];
    expect(restackVerdict(second(moved), moved, tracked(fact()))).toEqual({
      kind: "below-moved",
      layers: [101],
    });
  });

  test("a new head with identical changes is restacked", () => {
    const now = [layer(1, { headSha: "h1b" }), layer(2, { headSha: "h2b" })];
    expect(restackVerdict(second(now), now, tracked(fact())).kind).toBe("restacked");
  });

  test("a new head with different changes names the files", () => {
    const now = [layer(1), layer(2, { headSha: "h2b" })];
    const changed = fingerprintFiles([{ ...file, patch: "@@ -1 +1 @@\n-a\n+c" }]);
    expect(restackVerdict(second(now), now, tracked(fact(), changed))).toEqual({
      kind: "layer-changed",
      files: ["a.ts"],
    });
  });

  test("a merged layer below that this one still targets needs a rebase", () => {
    const now = [layer(1, { status: "merged" }), layer(2)];
    expect(restackVerdict(second(now), now, tracked(fact())).kind).toBe("needs-rebase");
  });

  test("a retargeted layer that can't merge cleanly needs a rebase", () => {
    const now = [
      layer(1, { status: "merged" }),
      layer(2, { baseRef: "main", mergeStateStatus: "DIRTY" }),
    ];
    expect(restackVerdict(second(now), now, tracked(fact())).kind).toBe("needs-rebase");
  });
});

describe("takeawayOf", () => {
  test("takes the first non-empty line, unformatted", () => {
    expect(takeawayOf("\n**Adds retries** to the poller.\n\n**Context** …")).toBe(
      "Adds retries to the poller.",
    );
  });
});

describe("fileOverlaps", () => {
  const stack = [layer(1, { status: "merged" }), layer(2), layer(3), layer(4), layer(5)];
  const withFiles = (prId: string, paths: string[]): TrackedLayer => ({
    prId,
    currentFingerprint: null,
    files: paths,
    current: null,
    latestComplete: null,
  });

  test("lists open layers sharing files, nearest first, above before below", () => {
    const facts = new Map<number, TrackedLayer>([
      [101, withFiles("p1", ["role.ts"])],
      [102, withFiles("p2", ["role.ts", "guard.ts"])],
      [103, withFiles("p3", ["guard.ts"])],
      [104, withFiles("p4", ["other.ts"])],
      [105, withFiles("p5", ["role.ts"])],
    ]);
    const viewer = facts.get(103);
    if (!viewer) throw new Error("fixture");
    facts.set(103, { ...viewer, files: ["guard.ts", "role.ts"] });
    expect(fileOverlaps(stack, facts, 103)).toEqual([
      { number: 102, position: 2, files: ["guard.ts", "role.ts"] },
      { number: 105, position: 5, files: ["role.ts"] },
    ]);
  });

  test("says nothing without the viewer's own files", () => {
    expect(fileOverlaps(stack, new Map(), 103)).toEqual([]);
  });
});
