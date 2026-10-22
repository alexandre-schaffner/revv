import {
  classifyLayerMergeState,
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
import type { GitHubStack, GitHubStackLayer } from "./map";

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
  readonly currentFingerprint: DiffFingerprint | null;
  readonly files: readonly string[] | null;
  readonly current: WalkthroughFact | null;
  readonly latestComplete: WalkthroughFact | null;
}

export interface RevvStackFacts {
  readonly repositoryId: string;
  readonly tracked: ReadonlyMap<number, TrackedLayer>;
  readonly brief: StackBrief | null;
}

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

  const reviewed = tracked?.latestComplete;
  if (!reviewed) return { kind: "unknown" };

  if (reviewed.prHeadSha !== null && reviewed.prHeadSha !== layer.headSha) {
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
