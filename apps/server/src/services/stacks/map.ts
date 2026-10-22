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

export interface GitHubStackLayer extends GitHubStackLayerFields {
  readonly nodeId: string;
}

export interface GitHubStack {
  readonly number: number;
  readonly baseRefName: string;
  readonly layers: readonly GitHubStackLayer[];
  readonly autoMergeAllowed: boolean;
  readonly allowedMethods: readonly MergeMethod[];
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

function allowedMethodsOf(repo: NonNullable<RawPrStackAnswer["repository"]>): MergeMethod[] {
  const methods: MergeMethod[] = [];
  if (repo.mergeCommitAllowed) methods.push("merge");
  if (repo.squashMergeAllowed) methods.push("squash");
  if (repo.rebaseMergeAllowed) methods.push("rebase");
  return methods;
}

export function mapGitHubStack(answer: RawPrStackAnswer, fetchedAt: string): GitHubStack | null {
  const repo = answer.repository;
  const stack = repo?.pullRequest?.stack;
  if (!repo || !stack) return null;
  const layers = (stack.entries.nodes ?? [])
    .flatMap((entry) => (entry?.pullRequest ? [mapLayer(entry.position, entry.pullRequest)] : []))
    .sort((a, b) => a.position - b.position);
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
  readonly fetchedAt: string;
}

function openMembership(
  layers: readonly {
    readonly number: number;
    readonly position: number;
    readonly status: string;
  }[],
): string {
  return layers
    .filter(isOpenLayer)
    .map((l) => `${l.number}@${l.position}`)
    .toSorted()
    .join(",");
}

/** The poll wrote `mirror` after `read` was taken, and puts different PRs at the open positions. */
export function membershipSupersededByPoll(
  read: GitHubStack,
  mirror: readonly MirroredLayer[],
): boolean {
  const pollWroteSince = mirror.some((l) => Date.parse(l.fetchedAt) > Date.parse(read.fetchedAt));
  return pollWroteSince && openMembership(read.layers) !== openMembership(mirror);
}

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
    baseRefName: rows[0]?.targetBranch ?? "",
    layers,
    autoMergeAllowed: false,
    allowedMethods: [],
    viewerCanPush: false,
    fetchedAt,
  };
}

export function layersToCompare(stack: GitHubStack): LayerComparison[] {
  return stack.layers
    .filter(isOpenLayer)
    .map((l) => ({ number: l.number, baseRef: l.baseRef, headRef: l.headRef }));
}

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
