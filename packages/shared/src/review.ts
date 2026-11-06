import { loginsMatch } from "./identity";

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

/** `wont_fix` closes a thread just as `resolved` does. */
export function isThreadResolved(status: string): boolean {
  return status === "resolved" || status === "wont_fix";
}

export type AuthorRole = "reviewer" | "coder" | "ai_agent";

export type MessageType = "comment" | "reply" | "suggestion" | "resolution";

export type HunkDecisionType = "accepted" | "rejected";

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
  pendingYou: number;
  pendingThem: number;
  resolved: number;
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

export interface HunkDecision {
  id: string;
  reviewSessionId: string;
  filePath: string;
  hunkIndex: number;
  decision: HunkDecisionType;
  decidedAt: string;
}
