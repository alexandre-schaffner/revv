import {
  classifyLayerMergeState,
  isOpenLayer,
  type PrStackDetail,
  type RestackVerdict,
  type StackBrief,
  type StackFileOverlap,
  type StackLayer,
  type StackLayerReview,
  type WalkthroughStatus,
} from "@revv/shared";
import type { DiffFingerprint } from "../../db/schema/walkthroughs";
import type { GitHubStack, GitHubStackLayer } from "../github/stacks";
import { changedFiles } from "../walkthrough/restack";
import type { FinishedReview } from "../walkthrough/review-reads";

/**
 * What "Review the stack" asks for when it queues a layer: the overlay's
 * `restacked` verdict says whether that request carries a review over.
 */
export const STACK_REVIEW_REQUEST = { mode: "reviewer", generationMode: "full" } as const;

export interface TrackedLayer {
  readonly prId: string;
  readonly currentFingerprint: DiffFingerprint | null;
  readonly files: readonly string[] | null;
  /** The review of the PR's head that stands, finished or not. */
  readonly current: { readonly id: string; readonly status: WalkthroughStatus } | null;
  readonly latestFinished: FinishedReview | null;
  /** A {@link STACK_REVIEW_REQUEST} run of this head would carry a finished review over. */
  readonly carries: boolean;
}

export interface RevvStackFacts {
  readonly repositoryId: string;
  readonly tracked: ReadonlyMap<number, TrackedLayer>;
  readonly brief: StackBrief | null;
}

function reviewOf(tracked: TrackedLayer | undefined): StackLayerReview {
  if (!tracked) return { kind: "none" };
  const { current, latestFinished: done } = tracked;
  if (current?.status === "generating") return { kind: "generating", walkthroughId: current.id };
  if (current?.status === "error" && !done) return { kind: "error", walkthroughId: current.id };
  if (!done) return { kind: "none" };
  return {
    kind: "complete",
    walkthroughId: done.id,
    riskLevel: done.riskLevel,
    openIssues: done.openIssues.length,
    criticalIssues: done.openIssues.filter((i) => i.severity === "critical").length,
    takeaway: done.takeaway,
    reviewedHeadSha: done.prHeadSha,
    carried: done.carried,
  };
}

export function restackVerdict(
  layer: GitHubStackLayer,
  layers: readonly GitHubStackLayer[],
  tracked: TrackedLayer | undefined,
): RestackVerdict {
  if (!isOpenLayer(layer)) return { kind: "current" };

  const below = layers.filter((l) => l.position < layer.position);
  const mergedBelow = below.filter((l) => l.status === "merged");
  const mergeState = classifyLayerMergeState(layer);
  if (
    mergedBelow.length > 0 &&
    (mergedBelow.some((l) => l.headRef === layer.baseRef) ||
      mergeState === "behind" ||
      mergeState === "conflicts")
  ) {
    return { kind: "needs-rebase" };
  }

  const reviewed = tracked?.latestFinished;
  if (!reviewed) return { kind: "unknown" };

  if (reviewed.prHeadSha !== layer.headSha) {
    if (tracked.carries) return { kind: "restacked" };
    const now = tracked.currentFingerprint;
    if (!reviewed.diffFingerprint || !now) return { kind: "unknown" };
    return { kind: "layer-changed", files: changedFiles(reviewed.diffFingerprint, now) };
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
      review: reviewOf(tracked),
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
