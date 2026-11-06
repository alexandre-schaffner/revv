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

/**
 * Revv's thinking-effort tiers. `extra-high` is Revv's key for the providers'
 * `xhigh` level (see `presets.ts` for the per-agent mapping). `ultrathink` is
 * retained only so persisted `user_settings.ai_thinking_effort` rows written
 * before the tier was retired still parse — no agent offers it, and both the
 * selector and `applyAgentDefaults` coerce it away on next render.
 */
export type ThinkingEffort =
  | "ultra"
  | "ultrathink"
  | "max"
  | "extra-high"
  | "high"
  | "medium"
  | "low";

/**
 * Event frames emitted over SSE while the server runs the opencode install
 * script (`curl … | bash` on macOS/Linux, `irm … | iex` on Windows). The
 * stream closes after `done`; on failure the message lives in `error`.
 */
export type InstallEvent =
  | { type: "log"; line: string }
  | { type: "done"; success: boolean; error?: string };

/**
 * Event frames emitted over SSE while the server drives an agent's interactive
 * CLI login inside a spawned pseudo-terminal (e.g. `codex login`,
 * `cursor-agent login`). `data` carries a raw terminal chunk to render into an
 * xterm instance; `auth-url` is the first `https?://…` the CLI printed (so the
 * UI can open it in the browser); the stream closes after `done`, whose
 * `success` reflects a fresh auth re-check. On failure the message lives in
 * `error`. Mirrors {@link InstallEvent}'s lifecycle.
 */
export type LoginEvent =
  | { type: "data"; chunk: string }
  | { type: "auth-url"; url: string }
  | { type: "done"; success: boolean; error?: string };

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

// ── Review domain types ──────────────────────────────────────────────────────

export type SessionStatus = "active" | "completed" | "abandoned";

/**
 * Review perspective for a PR. Two things carry one:
 *   - a review session (comments, threads, GitHub sync) — always derived from
 *     identity: `author` when the signed-in user is the PR's creator
 *     (self-review), otherwise `reviewer`;
 *   - a walkthrough — the user's pick, defaulting to that same identity answer.
 * Const-object "enum" (mirrors `PIERRE_THEME`) so the
 * values are referenced as `REVIEW_MODE.author` rather than bare strings,
 * while the persisted/wire value stays a plain string.
 */
export const REVIEW_MODE = {
  reviewer: "reviewer",
  author: "author",
} as const;

export type ReviewMode = (typeof REVIEW_MODE)[keyof typeof REVIEW_MODE];

export const REVIEW_MODES: readonly ReviewMode[] = [REVIEW_MODE.reviewer, REVIEW_MODE.author];

/**
 * Compare two provider logins. GitHub logins are case-insensitive, so `"Alex"`
 * and `"alex"` are the same account; either being absent is never a match.
 */
export function loginsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The review mode for a PR, given its author and the signed-in viewer.
 *
 * **This is the only implementation.** Review sessions are keyed on
 * `(pullRequestId, mode)`, so the web (which requests `?mode=`) and the
 * background workers (which write into a session) must derive the identical
 * answer from the identical inputs. A second copy of this rule that disagreed
 * on casing or on which login column it read is what sent synced GitHub
 * comments into a session the UI never loads — unrecoverably, since comments
 * dedupe globally by external id.
 *
 * `viewerLogin` is nullable because identity resolves asynchronously on both
 * sides. Unknown answers `reviewer`: the historical default and the right
 * answer for every PR the viewer did not write. Callers that would *act*
 * destructively on the result must distinguish "unknown" themselves rather
 * than reading a `reviewer` verdict as confirmation — see
 * `resolveReviewModeForPr` on the server.
 */
export function reviewModeFor(
  authorLogin: string | null | undefined,
  viewerLogin: string | null | undefined,
): ReviewMode {
  return loginsMatch(authorLogin, viewerLogin) ? REVIEW_MODE.author : REVIEW_MODE.reviewer;
}

export type ThreadStatus = "open" | "pending_coder" | "pending_reviewer" | "resolved" | "wont_fix";

export type AuthorRole = "reviewer" | "coder" | "ai_agent";

export type MessageType = "comment" | "reply" | "suggestion" | "resolution";

export interface ReviewSession {
  id: string;
  pullRequestId: string;
  mode: ReviewMode;
  startedAt: string;
  completedAt: string | null;
  status: SessionStatus;
}

export interface CommentThread {
  id: string;
  reviewSessionId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  diffSide: "old" | "new";
  status: ThreadStatus;
  createdAt: string;
  resolvedAt: string | null;
  externalThreadId: string | null;
  externalCommentId: string | null;
  lastSyncedAt: string | null;
}

export interface ThreadSummary {
  total: number;
  open: number;
  resolved: number;
}

export type UserRole = "reviewer" | "coder" | "unknown";

export interface UserIdentity {
  login: string | null;
  role: UserRole;
  /**
   * Base64 data URL of the user's avatar (e.g. "data:image/png;base64,...").
   * Resolved from the remote_users table so expired GitHub Enterprise signed
   * URLs never cause 404s.
   */
  avatarContent: string | null;
  /**
   * `true` when the signed-in user's GitHub login is on the project
   * maintainer allowlist (`MAINTAINER_LOGINS`). Maintainers see new updates
   * the moment CI publishes them — the 48h stable cooldown is bypassed.
   */
  isMaintainer: boolean;
  /**
   * `true` when the active account's GitHub token is invalid and could not be
   * silently refreshed — the client gates the app behind a re-sign-in modal.
   * Authoritative reconcile source for `auth:reauth-required` SSE signals on
   * boot / SSE reconnect. `host` is the account's GitHub host, used to drive
   * the re-auth device flow against the right instance.
   */
  reauthRequired: boolean;
  host: string | null;
}

export interface Org {
  login: string;
  avatarUrl: string | null;
}

export interface Team {
  /** GitHub team slug — unique within the org, used as the stable key. */
  slug: string;
  /** Human-readable team name. */
  name: string;
  /**
   * Logins of the team's members. Currently capped at the first 100 members
   * per team (and the first 100 teams per org) — see `listTeamsForOrg`.
   */
  memberLogins: string[];
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  authorRole: AuthorRole;
  authorName: string;
  authorLogin: string | null;
  /** Base64 data URL of the author's avatar (e.g. "data:image/png;base64,..."). */
  authorAvatarContent: string | null;
  body: string;
  messageType: MessageType;
  codeSuggestion: string | null;
  createdAt: string;
  editedAt: string | null;
  externalId: string | null;
}

export type SyncChangeKind = "review_requested" | "pr_updated" | "pr_closed" | "pr_authored";

export interface SyncChange {
  kind: SyncChangeKind;
  prId: string;
  prTitle: string;
  prNumber: number;
  repoFullName: string;
}
