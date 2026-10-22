import type { CiRollupState, PrStackEntry, ReviewDecision, ReviewVerdict } from "./conversation";
import type { MergeMethod } from "./types";
import type { RiskLevel } from "./walkthrough";

export function stackKey(repositoryId: string, stackNumber: number): string {
  return `${repositoryId}:${stackNumber}`;
}

export function isOpenLayer(layer: { readonly status: string }): boolean {
  return layer.status !== "merged" && layer.status !== "closed";
}

export const MERGEABLE_STATES: ReadonlySet<string> = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

export type StackLayerReview =
  | { readonly kind: "none" }
  | { readonly kind: "generating"; readonly walkthroughId: string }
  | {
      readonly kind: "complete";
      readonly walkthroughId: string;
      readonly riskLevel: RiskLevel | null;
      /** Open, unretracted concerns. */
      readonly openIssues: number;
      readonly criticalIssues: number;
      /** The overview's first line: the walkthrough's unlabelled takeaway. */
      readonly takeaway: string | null;
      /** The head this review read. Differs from the layer's head when stale. */
      readonly reviewedHeadSha: string | null;
      /** The review was carried over a restack instead of regenerated. */
      readonly carried: boolean;
    }
  | { readonly kind: "error"; readonly walkthroughId: string };

/**
 * How a layer's latest review relates to the stack as it stands now.
 *
 *   current        — reviewed at this head, and nothing below moved since.
 *   below-moved    — this layer is unchanged but a layer under it changed or
 *                    merged after the review; the review still reads true,
 *                    the context around it shifted.
 *   restacked      — a new head whose own changes are byte-identical to the
 *                    reviewed ones (a rebase onto a moved layer); the review
 *                    carries over.
 *   layer-changed  — the layer's own changes differ in `files`.
 *   needs-rebase   — a layer below merged and this one still carries its
 *                    changes (squash-merged base); the author has to restack.
 *   unknown        — no review, or one written before Revv tracked stacks.
 */
export type RestackVerdict =
  | { readonly kind: "current" }
  | { readonly kind: "below-moved"; readonly layers: readonly number[] }
  | { readonly kind: "restacked" }
  | { readonly kind: "layer-changed"; readonly files: readonly string[] }
  | { readonly kind: "needs-rebase" }
  | { readonly kind: "unknown" };

export interface GitHubStackLayerFields extends PrStackEntry {
  readonly headSha: string | null;
  /** The branch this layer targets: the layer below's head, or the stack base. */
  readonly baseRef: string;
  readonly mergeStateStatus: string | null;
  readonly reviewDecision: ReviewDecision | null;
  readonly viewerReview: ReviewVerdict | null;
  readonly checks: CiRollupState | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly authorLogin: string | null;
  readonly mergedAt: string | null;
  readonly autoMergeEnabled: boolean;
  readonly isInMergeQueue: boolean;
  /**
   * Commits on this layer's base branch that its head doesn't have: a stack
   * needs a rebase while any open layer is behind. Null when GitHub didn't
   * say (a merged layer, or a branch it couldn't compare).
   */
  readonly behindBy: number | null;
}

/**
 * A layer's GitHub merge state in the terms Revv acts on. The merge plan, the
 * merge driver, the restack verdict and the rebase offer all branch on this.
 *
 *   mergeable — GitHub would merge it now.
 *   behind    — its base has commits it lacks (BEHIND, or a compare said so).
 *               A stack only merges a linear history, so it needs a rebase.
 *   conflicts — DIRTY. A rebase of the stack may clear it (a squash-merged
 *               layer below) or may not.
 *   blocked   — BLOCKED: reviews, checks, protection, or the layers below.
 *   unknown   — GitHub is still computing it.
 *   unmodeled — any other state.
 */
export type LayerMergeState =
  | "mergeable"
  | "behind"
  | "conflicts"
  | "blocked"
  | "unknown"
  | "unmodeled";

export function classifyLayerMergeState(
  layer: Pick<GitHubStackLayerFields, "mergeStateStatus" | "behindBy">,
): LayerMergeState {
  const state = layer.mergeStateStatus ?? "UNKNOWN";
  if (state === "DIRTY") return "conflicts";
  if (state === "BEHIND" || (layer.behindBy ?? 0) > 0) return "behind";
  if (MERGEABLE_STATES.has(state)) return "mergeable";
  if (state === "BLOCKED") return "blocked";
  return state === "UNKNOWN" ? "unknown" : "unmodeled";
}

export interface StackLayer extends GitHubStackLayerFields {
  /** Revv's row for this PR, or null when Revv doesn't track it (yet). */
  readonly prId: string | null;
  readonly review: StackLayerReview;
  readonly restack: RestackVerdict;
}

export interface PrStackDetail {
  readonly repositoryId: string;
  readonly number: number;
  readonly baseRefName: string;
  /** Ordered by position, base first. */
  readonly layers: readonly StackLayer[];
  /** Where the PR that asked sits. */
  readonly viewerPosition: number;
  readonly autoMergeAllowed: boolean;
  /** Merge methods the repository permits, in GitHub's order of preference. */
  readonly allowedMethods: readonly MergeMethod[];
  readonly viewerCanPush: boolean;
  readonly brief: StackBrief | null;
  /** Open layers sharing files with the viewer's layer, nearest first. */
  readonly overlaps: readonly StackFileOverlap[];
  readonly fetchedAt: string;
  /** GitHub couldn't be reached; the GitHub half is the last good answer. */
  readonly stale: boolean;
}

export type StackBriefStatus = "generating" | "complete" | "error" | "superseded";

export interface StackBriefLayer {
  readonly position: number;
  readonly prNumber: number;
  /** One line: what this layer contributes to the stack. */
  readonly role: string;
  /** One line: where a reviewer of this layer should look hardest. */
  readonly reviewFocus: string;
  /** The stack phase this layer belongs to, 1–3 words ("Roles", "Storage"). */
  readonly chapter: string;
  /** The lower layers this one stands on, and what it takes from each. */
  readonly buildsOn: readonly StackLayerLink[];
}

export interface StackLayerLink {
  readonly number: number;
  /** A phrase: what the upper layer takes from it ("the explicit role model"). */
  readonly uses: string;
}

/**
 * Another open layer that changes files the viewer's layer also changes: what
 * a reviewer here wants to know before asking for a fix that layer would
 * rewrite (above), or that this layer rewrites (below). Read from the file
 * lists Revv holds; a layer it hasn't fetched files for is absent.
 */
export interface StackFileOverlap {
  readonly number: number;
  readonly position: number;
  /** Shared paths, sorted. */
  readonly files: readonly string[];
}

export interface StackBrief {
  readonly id: string;
  readonly status: StackBriefStatus;
  /** The stack moved since this brief was written. */
  readonly stale: boolean;
  /** A short paragraph: the arc of the whole stack. */
  readonly arc: string;
  /** PR numbers in the order the brief recommends reviewing them. */
  readonly reviewOrder: readonly number[];
  readonly layers: readonly StackBriefLayer[];
  readonly completedAt: string | null;
}

/** `remaining`: layers without a current walkthrough. `all`: every open layer. */
export type StackReviewScope = "remaining" | "all";

export interface StackReviewStarted {
  /** PR numbers queued, bottom-up. */
  readonly queued: readonly number[];
  /** Open layers Revv can't review because it doesn't track them. */
  readonly untracked: readonly number[];
}

export type StackMergeLayerState =
  | "pending"
  | "retargeting"
  | "merging"
  | "merged"
  | "auto_merge"
  | "rebasing"
  | "failed";

export interface StackMergeRunLayer {
  readonly position: number;
  readonly number: number;
  /** The head the user confirmed; a layer that moved since is never merged. */
  readonly expectedHeadSha: string;
  readonly state: StackMergeLayerState;
  readonly message: string | null;
  /**
   * The head the run rebased away from. Set once the run rebased this layer
   * itself: `expectedHeadSha` is then the rebased head, and a read still
   * showing this one is GitHub catching up, not new commits.
   */
  readonly rebasedFrom?: string;
  /**
   * The run rebased the stack to merge this layer. One still behind after
   * that needs a hand, not another rebase.
   */
  readonly rebasedToMerge?: boolean;
}

export interface WalkthroughStackSnapshot {
  readonly number: number;
  readonly baseRefName: string;
  /** This walkthrough's layer. */
  readonly position: number;
  readonly layers: ReadonlyArray<{
    readonly position: number;
    readonly number: number;
    readonly title: string;
    readonly headSha: string | null;
    readonly baseRef: string;
    readonly status: PrStackEntry["status"];
  }>;
  readonly capturedAt: string;
}

/**
 * What a stack builds, named for the homepage queue. `brief`: the gist is the
 * stack brief's opening sentence. `model`: a one-shot name from the cheap
 * suggestions model. `titles`: derived from the PR titles while (or instead
 * of) asking a model; `gist` is null then.
 */
export interface StackHeadline {
  readonly headline: string;
  readonly gist: string | null;
  readonly source: "brief" | "model" | "titles";
}
