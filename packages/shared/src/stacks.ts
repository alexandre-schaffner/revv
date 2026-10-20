// ── GitHub PR stacks, as the review page sees them ──────────────────────────
//
// GitHub owns a stack's shape (which PRs, in what order, merged or not);
// Revv owns what it knows about each layer (is it tracked here, has it been
// reviewed, did the layer below move since). `PrStackDetail` is both, joined:
// the GitHub half comes from one GraphQL read cached briefly on the server,
// the Revv half is recomputed from the DB on every read.

import type {
  CiRollupState,
  PrStackEntry,
  ReviewDecision,
  ReviewVerdict,
  StackEntryStatus,
} from "./conversation";
import type { MergeMethod } from "./types";
import type { RiskLevel } from "./walkthrough";

/** The client's key for one stack: stack numbers are unique per repository. */
export function stackKey(repositoryId: string, stackNumber: number): string {
  return `${repositoryId}:${stackNumber}`;
}

/** What Revv's walkthroughs know about one layer at its current head. */
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

export interface StackLayer extends PrStackEntry {
  readonly headSha: string | null;
  /** The branch this layer targets: the layer below's head, or the stack base. */
  readonly baseRef: string;
  readonly mergeStateStatus: string | null;
  readonly reviewDecision: ReviewDecision | null;
  /** The viewer's own latest verdict on this layer. */
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
  /** Revv's row for this PR, or null when Revv doesn't track it (yet). */
  readonly prId: string | null;
  readonly review: StackLayerReview;
  readonly restack: RestackVerdict;
}

export interface PrStackDetail {
  readonly repositoryId: string;
  readonly number: number;
  /** The branch the bottom of the stack targets. */
  readonly baseRefName: string;
  /** Ordered by position, base first. */
  readonly layers: readonly StackLayer[];
  /** Where the PR that asked sits. */
  readonly viewerPosition: number;
  readonly autoMergeAllowed: boolean;
  /** Merge methods the repository permits, in GitHub's order of preference. */
  readonly allowedMethods: readonly MergeMethod[];
  /** The viewer may push to the repository, so Revv can rebase the stack for them. */
  readonly viewerCanPush: boolean;
  readonly brief: StackBrief | null;
  /** Open layers sharing files with the viewer's layer, nearest first. */
  readonly overlaps: readonly StackFileOverlap[];
  readonly fetchedAt: string;
  /** GitHub couldn't be reached; the GitHub half is the last good answer. */
  readonly stale: boolean;
}

// ── Stack brief ─────────────────────────────────────────────────────────────

export type StackBriefStatus = "generating" | "complete" | "error" | "superseded";

export interface StackBriefLayer {
  readonly position: number;
  readonly prNumber: number;
  /** One line: what this layer contributes to the stack. */
  readonly role: string;
  /** One line: where a reviewer of this layer should look hardest. */
  readonly reviewFocus: string;
  /** The stack phase this layer belongs to; null for briefs written before chapters. */
  readonly chapter: string | null;
  /** The lower layers this one stands on, and what it takes from each. */
  readonly buildsOn: readonly StackLayerLink[];
}

/** One layer leaning on another below it. */
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

/** The agent-written whole-stack overview, one per stack version. */
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

// ── Stack review ────────────────────────────────────────────────────────────

/** `remaining`: layers without a current walkthrough. `all`: every open layer. */
export type StackReviewScope = "remaining" | "all";

export interface StackReviewStarted {
  /** PR numbers queued, bottom-up. */
  readonly queued: readonly number[];
  /** Open layers Revv can't review because it doesn't track them. */
  readonly untracked: readonly number[];
}

// ── Stack merge ─────────────────────────────────────────────────────────────

/**
 * `auto`: Revv merges what it can now and hands the rest to GitHub's
 * auto-merge, which finishes even with Revv closed. `driven`: Revv merges
 * each layer itself, bottom-up, and has to stay open until it's done.
 */
export type StackMergeMode = "auto" | "driven";

export type StackMergeReadiness = "merged" | "ready" | "blocked";

export interface StackMergePlanLayer {
  readonly position: number;
  readonly number: number;
  readonly title: string;
  readonly prId: string | null;
  readonly headSha: string | null;
  /** GitHub's own label for the layer, for the same glyph the stack list draws. */
  readonly status: StackEntryStatus;
  readonly readiness: StackMergeReadiness;
  /**
   * Why a blocked layer can't merge, in the reader's terms. A ready layer may
   * carry one too: what it's still waiting on (checks auto-merge will wait out).
   */
  readonly reasons: readonly string[];
}

export interface StackMergePlan {
  readonly repositoryId: string;
  readonly stackNumber: number;
  readonly baseRefName: string;
  readonly layers: readonly StackMergePlanLayer[];
  /** Highest position reachable through contiguous ready layers, or null. */
  readonly defaultThrough: number | null;
  readonly allowedMethods: readonly MergeMethod[];
  readonly mode: StackMergeMode;
  /**
   * The stack's latest run while it's live (`running` / `waiting`) or stopped
   * with a Continue (`failed` / `expired`); null once it completed or was
   * cancelled. Only a live run blocks starting another.
   */
  readonly activeRun: StackMergeRun | null;
}

export type StackMergeRunStatus =
  | "running"
  | "waiting"
  | "complete"
  | "failed"
  | "cancelled"
  | "expired";

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
}

export interface StackMergeRun {
  readonly id: string;
  readonly repositoryId: string;
  readonly stackNumber: number;
  readonly throughPosition: number;
  readonly method: MergeMethod;
  readonly mode: StackMergeMode;
  readonly status: StackMergeRunStatus;
  readonly layers: readonly StackMergeRunLayer[];
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Stack rebase ────────────────────────────────────────────────────────────

/**
 * What `POST /api/prs/:id/stack/rebase` did: every open layer replayed onto
 * the one below it (the bottom onto the stack base), pushed in one atomic
 * push. `rebased` is empty when the stack was already linear.
 */
export interface StackRebaseResult {
  readonly rebased: ReadonlyArray<{
    readonly number: number;
    readonly from: string;
    readonly to: string;
  }>;
  /** Layers pointed at the stack base because the layer below had merged. */
  readonly retargeted: readonly number[];
}

// ── Walkthrough stack snapshot ──────────────────────────────────────────────

/**
 * The stack as a walkthrough's agent saw it, captured at job start and kept
 * on the walkthrough row: a resume prompts with the same stack, and a later
 * read can tell which layers moved since.
 */
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

// ── Stack headline ──────────────────────────────────────────────────────────

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
