export type PullRequestStatus = "open" | "closed" | "merged";

export type ReviewStatus =
  | "pending"
  | "in_progress"
  | "walkthrough_ready"
  | "reviewed"
  | "changes_proposed";

export type CloneStatus = "pending" | "cloning" | "ready" | "error";

export interface Repository {
  id: string;
  provider: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  avatarUrl: string | null;
  addedAt: string;
  cloneStatus: CloneStatus;
  clonePath: string | null;
  cloneError: string | null;
  managed: boolean;
  githubHost: string;
}

export interface PullRequest {
  id: string;
  externalId: number;
  repositoryId: string;
  title: string;
  body: string | null;
  authorLogin: string;
  /** Base64 data URL of the author's avatar (e.g. "data:image/png;base64,..."). */
  authorAvatarContent: string | null;
  /** Raw avatar URL from the provider — used internally during sync to populate remote_users. */
  authorAvatarUrl: string | null;
  requestedReviewers: string[];
  /**
   * Logins @-mentioned in the PR body or in any of its review comments.
   *
   * Populated on the DB read path only (`rowToPr`); always `[]` when a PR is
   * mapped straight from a GitHub API payload, since GitHub has no such field
   * — mentions are parsed out of the body and merged with comment-sourced
   * mentions during sync.
   */
  mentionedUsers: string[];
  status: PullRequestStatus;
  reviewStatus: ReviewStatus;
  /** GitHub draft state — `true` while the PR is in draft. */
  isDraft: boolean;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headSha: string | null;
  baseSha: string | null;
  createdAt: string;
  updatedAt: string;
  fetchedAt: string;
  closedAt: string | null;
  /**
   * GitHub's native stack this PR sits in, or null when it isn't stacked (or
   * the host predates stacks). Not inferred from branch chains: a merged
   * bottom PR gets retargeted and drops out of any branch walk.
   */
  stack: PrStackPlace | null;
}

export interface PrStackPlace {
  /** The stack's number, unique within the repo. */
  number: number;
  /** 1 sits on the base branch. */
  position: number;
}

export function sameStack(a: PrStackPlace | null, b: PrStackPlace | null): boolean {
  return a?.number === b?.number && a?.position === b?.position;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergeEligibility {
  canMerge: boolean;
  /**
   * The viewer may merge past branch protections (GitHub's
   * `viewerCanMergeAsAdmin`; on a host too old to answer, an ADMIN
   * permission). Such a viewer can still merge a `BLOCKED` PR, never a
   * conflicting or draft one.
   */
  canBypassProtections: boolean;
  mergeable: boolean;
  mergeStateStatus: string;
  /**
   * The merge methods this repository's settings actually permit. GitHub
   * answers `PUT /pulls/:n/merge` with a 405 ("Merge commits are not allowed
   * on this repository.") when the requested method is disabled, so the UI
   * must offer only these — never the full {@link MergeMethod} set.
   */
  allowedMethods: MergeMethod[];
}

export type SyncChangeKind = "review_requested" | "pr_updated" | "pr_closed" | "pr_authored";

export interface SyncChange {
  kind: SyncChangeKind;
  prId: string;
  prTitle: string;
  prNumber: number;
  repoFullName: string;
}
