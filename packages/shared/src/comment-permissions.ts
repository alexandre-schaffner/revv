import { loginsMatch } from "./identity";
import { isThreadResolved } from "./review";

export interface CommentPermissionMessage {
  readonly authorRole: string;
  readonly authorLogin: string | null;
  readonly externalId: string | null;
}

export interface DraftReviewMessage extends CommentPermissionMessage {
  readonly body: string;
}

/**
 * A local draft can be edited or discarded by the signed-in user when Revv
 * authored it, or when its provider login matches the active account.
 * GitHub-backed messages are immutable in Revv and must be edited on GitHub.
 */
export function canUserModifyComment(
  message: CommentPermissionMessage,
  currentUserLogin: string | null,
): boolean {
  if (message.externalId !== null) return false;
  if (message.authorRole === "ai_agent") return true;
  return loginsMatch(message.authorLogin, currentUserLogin);
}

/**
 * A draft the signed-in user publishes: one they may still change (theirs or
 * Revv's, not yet on GitHub) with some text. An external coding agent's reply
 * is not theirs; it goes up only when the agent asks.
 */
export function isPublishableDraftComment(
  message: DraftReviewMessage,
  viewerLogin: string | null,
): boolean {
  return canUserModifyComment(message, viewerLogin) && message.body.trim().length > 0;
}

export interface DraftThread {
  readonly status: string;
  readonly externalCommentId: string | null;
}

/**
 * What a thread not yet on GitHub posts as one review comment: its publishable
 * drafts, joined. Null when it posts nothing (resolved, already on GitHub, or
 * no draft with text).
 */
export function draftCommentBody(
  thread: DraftThread,
  messages: readonly DraftReviewMessage[],
  viewerLogin: string | null,
): string | null {
  if (isThreadResolved(thread.status)) return null;
  if (thread.externalCommentId !== null) return null;
  const body = messages
    .filter((m) => isPublishableDraftComment(m, viewerLogin))
    .map((m) => m.body)
    .join("\n\n");
  return body === "" ? null : body;
}

/** A thread already on GitHub posts its publishable drafts as replies, in order. */
export function unpublishedReplies<M extends DraftReviewMessage>(
  thread: DraftThread,
  messages: readonly M[],
  viewerLogin: string | null,
): M[] {
  if (thread.externalCommentId === null) return [];
  return messages.filter((m) => isPublishableDraftComment(m, viewerLogin));
}
