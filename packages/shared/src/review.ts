import { loginsMatch } from "./identity";

/**
 * The signed-in user's lens on a PR: `author` when they created it
 * (self-review), otherwise `reviewer`. It is the default walkthrough
 * perspective, which the user can change per generation. A PR's comment
 * threads don't depend on it: a PR has one review, whoever looks at it.
 */
export const REVIEW_MODE = {
  reviewer: "reviewer",
  author: "author",
} as const;

export type ReviewMode = (typeof REVIEW_MODE)[keyof typeof REVIEW_MODE];

export const REVIEW_MODES: readonly ReviewMode[] = [REVIEW_MODE.reviewer, REVIEW_MODE.author];

/**
 * The review mode for a PR, given its author and the signed-in viewer.
 * `viewerLogin` is nullable because identity resolves asynchronously; unknown
 * answers `reviewer`, the right answer for every PR the viewer did not write.
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

export const AUTHOR_ROLES = ["reviewer", "coder", "ai_agent"] as const;
export type AuthorRole = (typeof AUTHOR_ROLES)[number];

/** A thread's first message is its `comment`; every later one is a `reply`. */
export const MESSAGE_TYPES = ["comment", "reply"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

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
  createdAt: string;
  editedAt: string | null;
  externalId: string | null;
}
