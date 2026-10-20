// ── Revv's half of a stack ──────────────────────────────────────────────────
//
// Joins what GitHub says about a stack with what Revv knows about each layer:
// is it tracked here, what did its latest walkthrough find, and did the
// stack move under that walkthrough since. Pure: the facts are read from the
// DB by `StackService` on every request and never cached, so a walkthrough
// landing shows up on the next read without invalidating anything.

import {
  isOpenLayer,
  type PrStackDetail,
  type RestackVerdict,
  type RiskLevel,
  type StackBrief,
  type StackFileOverlap,
  type StackLayer,
  type StackLayerReview,
  type WalkthroughStackSnapshot,
} from "@revv/shared";
import { changedFiles, type DiffFingerprint, isComparable } from "./fingerprint";
import { classifyLayerMergeState, type GitHubStack, type GitHubStackLayer } from "./map";

/** One walkthrough row, as much of it as the overlay reads. */
export interface WalkthroughFact {
  readonly id: string;
  readonly status: "generating" | "complete" | "error" | "superseded";
  readonly prHeadSha: string | null;
  readonly riskLevel: RiskLevel | null;
  readonly summary: string;
  readonly openIssues: number;
  readonly criticalIssues: number;
  readonly stackContext: WalkthroughStackSnapshot | null;
  readonly fingerprint: DiffFingerprint | null;
  readonly carried: boolean;
}

export interface TrackedLayer {
  readonly prId: string;
  /** The layer's fingerprint at its current head, when Revv has its files cached. */
  readonly currentFingerprint: DiffFingerprint | null;
  /** The layer's changed paths at its current head, when Revv has them cached. */
  readonly files: readonly string[] | null;
  /** The live walkthrough row at the layer's current head, if any. */
  readonly current: WalkthroughFact | null;
  /** The newest walkthrough that finished all four phases, at any head. */
  readonly latestComplete: WalkthroughFact | null;
}

export interface RevvStackFacts {
  readonly repositoryId: string;
  /** Keyed on PR number. */
  readonly tracked: ReadonlyMap<number, TrackedLayer>;
  readonly brief: StackBrief | null;
}

/** The overview's first line is the walkthrough's unlabelled takeaway. */
export function takeawayOf(summary: string): string | null {
  for (const raw of summary.split("\n")) {
    const line = raw
      .replace(/^[#>*\-\s]+/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (line) return line;
  }
  return null;
}

function reviewOf(layer: GitHubStackLayer, tracked: TrackedLayer | undefined): StackLayerReview {
  if (!tracked) return { kind: "none" };
  const { current, latestComplete } = tracked;
  if (current?.status === "generating") return { kind: "generating", walkthroughId: current.id };
  if (current?.status === "error" && !latestComplete) {
    return { kind: "error", walkthroughId: current.id };
  }
  const done = current?.status === "complete" ? current : latestComplete;
  if (!done) return { kind: "none" };
  return {
    kind: "complete",
    walkthroughId: done.id,
    riskLevel: done.riskLevel,
    openIssues: done.openIssues,
    criticalIssues: done.criticalIssues,
    takeaway: takeawayOf(done.summary),
    reviewedHeadSha: done.prHeadSha ?? layer.headSha,
    carried: done.carried,
  };
}

/**
 * How this layer's latest review relates to the stack now. Merged and closed
 * layers are done; their review needs no verdict.
 */
export function restackVerdict(
  layer: GitHubStackLayer,
  layers: readonly GitHubStackLayer[],
  tracked: TrackedLayer | undefined,
): RestackVerdict {
  if (!isOpenLayer(layer)) return { kind: "current" };

  const below = layers.filter((l) => l.position < layer.position);
  const mergedBelow = below.filter((l) => l.status === "merged");
  // A layer below landed, and this one still targets its branch, is behind
  // its base or conflicts with it: the author has to restack before anything
  // else matters.
  const mergeState = classifyLayerMergeState(layer);
  if (
    mergedBelow.length > 0 &&
    (mergedBelow.some((l) => l.headRef === layer.baseRef) ||
      mergeState === "behind" ||
      mergeState === "conflicts")
  ) {
    return { kind: "needs-rebase" };
  }

  const reviewed = tracked?.latestComplete;
  if (!reviewed) return { kind: "unknown" };

  if (reviewed.prHeadSha !== null && reviewed.prHeadSha !== layer.headSha) {
    // A newer head than the review read. Whether the layer's own changes
    // moved is a question for the fingerprints.
    const now = tracked.currentFingerprint;
    if (!reviewed.fingerprint || !now) return { kind: "unknown" };
    const files = changedFiles(reviewed.fingerprint, now);
    if (files.length === 0 && isComparable(now)) return { kind: "restacked" };
    return { kind: "layer-changed", files };
  }

  const snapshot = reviewed.stackContext;
  if (!snapshot) return { kind: "current" };
  const thenByNumber = new Map(snapshot.layers.map((l) => [l.number, l]));
  const moved = below
    .filter((l) => {
      const then = thenByNumber.get(l.number);
      return !then || then.headSha !== l.headSha || then.status !== l.status;
    })
    .map((l) => l.number);
  return moved.length > 0 ? { kind: "below-moved", layers: moved } : { kind: "current" };
}

/**
 * The open layers that change files the viewer's layer changes, nearest
 * first and, at equal distance, the one above first: a fix asked for here
 * may be rewritten there. Layers Revv holds no files for are left out rather
 * than guessed at.
 */
export function fileOverlaps(
  layers: readonly GitHubStackLayer[],
  tracked: ReadonlyMap<number, TrackedLayer>,
  viewerNumber: number,
): StackFileOverlap[] {
  const viewer = layers.find((l) => l.number === viewerNumber);
  const mine = tracked.get(viewerNumber)?.files;
  if (!viewer || !mine || mine.length === 0) return [];
  const own = new Set(mine);
  return layers
    .filter((l) => l.number !== viewerNumber && isOpenLayer(l))
    .flatMap((l): StackFileOverlap[] => {
      const files = (tracked.get(l.number)?.files ?? []).filter((f) => own.has(f)).sort();
      return files.length > 0 ? [{ number: l.number, position: l.position, files }] : [];
    })
    .sort((a, b) => {
      const distance =
        Math.abs(a.position - viewer.position) - Math.abs(b.position - viewer.position);
      return distance !== 0 ? distance : b.position - a.position;
    });
}

export function overlayStack(
  github: GitHubStack,
  facts: RevvStackFacts,
  viewerNumber: number,
  stale: boolean,
): PrStackDetail {
  const layers: StackLayer[] = github.layers.map((layer) => {
    const tracked = facts.tracked.get(layer.number);
    const { nodeId: _nodeId, ...rest } = layer;
    return {
      ...rest,
      prId: tracked?.prId ?? null,
      review: reviewOf(layer, tracked),
      restack: restackVerdict(layer, github.layers, tracked),
    };
  });
  return {
    repositoryId: facts.repositoryId,
    number: github.number,
    baseRefName: github.baseRefName,
    layers,
    viewerPosition: github.layers.find((l) => l.number === viewerNumber)?.position ?? 0,
    autoMergeAllowed: github.autoMergeAllowed,
    allowedMethods: github.allowedMethods,
    viewerCanPush: github.viewerCanPush,
    brief: facts.brief,
    overlaps: fileOverlaps(github.layers, facts.tracked, viewerNumber),
    fetchedAt: github.fetchedAt,
    stale,
  };
}
