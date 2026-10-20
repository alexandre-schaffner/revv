// ── Stack mapping ───────────────────────────────────────────────────────────
//
// GitHub's raw stack → the GitHub half of `PrStackDetail`. The Revv half
// (tracked rows, reviews, restack verdicts) is joined on in `overlay.ts`.

import {
  type CiRollupState,
  type GitHubStackLayerFields,
  isOpenLayer,
  MERGEABLE_STATES,
  type MergeMethod,
  type ReviewDecision,
  type ReviewVerdict,
  type StackEntryStatus,
} from "@revv/shared";
import type {
  LayerComparison,
  RawLayerCompareAnswer,
  RawPrStackAnswer,
  RawStackPullRequest,
} from "./queries";

/** Where a stacked PR stands, the way GitHub's stack list labels it. */
export function stackStatus(pr: {
  readonly state: string;
  readonly isDraft: boolean;
  readonly mergeStateStatus: string | null;
}): StackEntryStatus {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  return MERGEABLE_STATES.has(pr.mergeStateStatus ?? "") ? "ready" : "not_ready";
}

/** One layer as GitHub reports it, before Revv's overlay. */
export interface GitHubStackLayer extends GitHubStackLayerFields {
  /** For GraphQL mutations (auto-merge); never sent to the client. */
  readonly nodeId: string;
}

/**
 * A layer's GitHub merge state in the terms Revv acts on. The merge plan, the
 * merge driver and the restack verdict all branch on this.
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
type LayerMergeState = "mergeable" | "behind" | "conflicts" | "blocked" | "unknown" | "unmodeled";

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

/** The GitHub half of a stack, cached briefly on the server. */
export interface GitHubStack {
  readonly number: number;
  readonly baseRefName: string;
  /** Ordered by position, base first. */
  readonly layers: readonly GitHubStackLayer[];
  readonly autoMergeAllowed: boolean;
  readonly allowedMethods: readonly MergeMethod[];
  /** WRITE or above: Revv may push the layers' branches (a rebase). */
  readonly viewerCanPush: boolean;
  readonly fetchedAt: string;
}

const REVIEW_DECISIONS: Record<string, ReviewDecision> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

const VERDICTS: Record<string, ReviewVerdict> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

const ROLLUP_STATES: Record<string, CiRollupState> = {
  SUCCESS: "success",
  FAILURE: "failure",
  PENDING: "pending",
  ERROR: "error",
  EXPECTED: "expected",
};

function mapLayer(position: number, pr: RawStackPullRequest): GitHubStackLayer {
  const rollup = pr.commits?.nodes?.[0]?.commit.statusCheckRollup?.state ?? null;
  return {
    nodeId: pr.id,
    position,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRef: pr.headRefName,
    status: stackStatus(pr),
    headSha: pr.headRefOid,
    baseRef: pr.baseRefName,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision ? (REVIEW_DECISIONS[pr.reviewDecision] ?? null) : null,
    viewerReview: pr.viewerLatestReview ? (VERDICTS[pr.viewerLatestReview.state] ?? null) : null,
    checks: rollup ? (ROLLUP_STATES[rollup] ?? null) : null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    authorLogin: pr.author?.login ?? null,
    mergedAt: pr.mergedAt,
    autoMergeEnabled: pr.autoMergeRequest !== null,
    isInMergeQueue: pr.isInMergeQueue,
    behindBy: null,
  };
}

const PUSH_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

/** GitHub's own order of preference, the one its merge button offers. */
function allowedMethodsOf(repo: NonNullable<RawPrStackAnswer["repository"]>): MergeMethod[] {
  const methods: MergeMethod[] = [];
  if (repo.mergeCommitAllowed) methods.push("merge");
  if (repo.squashMergeAllowed) methods.push("squash");
  if (repo.rebaseMergeAllowed) methods.push("rebase");
  return methods;
}

/** Null when the PR isn't stacked, or sits alone in its stack. */
export function mapGitHubStack(answer: RawPrStackAnswer, fetchedAt: string): GitHubStack | null {
  const repo = answer.repository;
  const stack = repo?.pullRequest?.stack;
  if (!repo || !stack) return null;
  const layers = (stack.entries.nodes ?? [])
    .flatMap((entry) => (entry?.pullRequest ? [mapLayer(entry.position, entry.pullRequest)] : []))
    .sort((a, b) => a.position - b.position);
  // A stack of one is just a PR.
  if (layers.length < 2) return null;
  return {
    number: stack.number,
    baseRefName: stack.baseRefName,
    layers,
    autoMergeAllowed: repo.autoMergeAllowed,
    allowedMethods: allowedMethodsOf(repo),
    viewerCanPush: PUSH_PERMISSIONS.has(repo.viewerPermission ?? ""),
    fetchedAt,
  };
}

// ── The poll's mirror of a stack ────────────────────────────────────────────

/** A `pull_requests` row the poll recorded in a stack, as much as a layer needs. */
export interface MirroredLayer {
  readonly number: number;
  readonly position: number;
  readonly title: string;
  readonly url: string;
  readonly status: string;
  readonly isDraft: boolean;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly headSha: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly authorLogin: string;
  readonly closedAt: string | null;
  /** When the poll last wrote the row. */
  readonly fetchedAt: string;
}

/**
 * Whether a stack read agrees with the poll on the open layers: the same PRs
 * at the same positions. A stack is rebuilt by re-creating it, so after a
 * rebuild an older read (cached, or answered while GitHub was half there)
 * holds the right PR in the wrong stack. The poll re-lists stacked repos
 * every cycle, so it is the fresher word on membership.
 */
export function agreesWithMirror(stack: GitHubStack, mirror: readonly MirroredLayer[]): boolean {
  // A read taken after the poll's last word is the newer word.
  if (mirror.every((l) => Date.parse(l.fetchedAt) <= Date.parse(stack.fetchedAt))) return true;
  const open = (pairs: [number, number][]) =>
    pairs
      .sort((a, b) => a[0] - b[0])
      .map(([number, position]) => `${number}@${position}`)
      .join(",");
  return (
    open(stack.layers.filter(isOpenLayer).map((l) => [l.number, l.position])) ===
    open(mirror.filter(isOpenLayer).map((l) => [l.number, l.position]))
  );
}

/**
 * The stack rebuilt from the poll's rows alone, for when GitHub can't be
 * asked. Membership and order are the poll's; what only the stack query
 * knows (merge readiness, reviews, checks) is unknown, so an open layer reads
 * `draft` or `not_ready` and the repo offers no merge methods. Null for a
 * stack of one.
 */
export function stackFromMirror(
  stackNumber: number,
  mirror: readonly MirroredLayer[],
  fetchedAt: string,
): GitHubStack | null {
  const rows = mirror.toSorted((a, b) => a.position - b.position);
  if (rows.length < 2) return null;
  const layers = rows.map(
    (row): GitHubStackLayer => ({
      nodeId: "",
      position: row.position,
      number: row.number,
      title: row.title,
      url: row.url,
      headRef: row.sourceBranch,
      status:
        row.status === "merged"
          ? "merged"
          : row.status === "closed"
            ? "closed"
            : row.isDraft
              ? "draft"
              : "not_ready",
      headSha: row.headSha,
      baseRef: row.targetBranch,
      mergeStateStatus: null,
      reviewDecision: null,
      viewerReview: null,
      checks: null,
      additions: row.additions,
      deletions: row.deletions,
      changedFiles: row.changedFiles,
      authorLogin: row.authorLogin,
      mergedAt: row.status === "merged" ? row.closedAt : null,
      autoMergeEnabled: false,
      isInMergeQueue: false,
      behindBy: null,
    }),
  );
  return {
    number: stackNumber,
    // The bottom layer targets the stack's base.
    baseRefName: rows[0]?.targetBranch ?? "",
    layers,
    autoMergeAllowed: false,
    allowedMethods: [],
    viewerCanPush: false,
    fetchedAt,
  };
}

/** Open layers, whose base tip a rebase would have to put under them. */
export function layersToCompare(stack: GitHubStack): LayerComparison[] {
  return stack.layers
    .filter(isOpenLayer)
    .map((l) => ({ number: l.number, baseRef: l.baseRef, headRef: l.headRef }));
}

/** The stack with each compared layer's `behindBy` filled in. */
export function withBehind(stack: GitHubStack, answer: RawLayerCompareAnswer): GitHubStack {
  const repo = answer.repository;
  if (!repo) return stack;
  return {
    ...stack,
    layers: stack.layers.map((layer) => {
      const behindBy = repo[`l${layer.number}`]?.compare?.behindBy;
      return typeof behindBy === "number" ? { ...layer, behindBy } : layer;
    }),
  };
}
