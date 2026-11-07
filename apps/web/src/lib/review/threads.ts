// The rules the review surfaces apply to comment threads, and what a review
// submit posts from them by the same rules the server applies
// (`@revv/shared` comment-permissions).

import {
  type CommentThread,
  canUserModifyComment,
  draftCommentBody,
  pendingReplies,
  type ThreadMessage,
} from "@revv/shared";
import { getThreadMessages, getThreads } from "$lib/stores/review.svelte";

/** Not on GitHub yet: a local draft. */
export function isPendingThread(thread: Pick<CommentThread, "externalCommentId">): boolean {
  return thread.externalCommentId == null;
}

/** A draft the signed-in user may throw away (the server refuses the rest). */
export function canDiscardThread(
  thread: CommentThread,
  messages: readonly ThreadMessage[],
  currentUserLogin: string | null,
): boolean {
  const first = messages[0];
  return (
    isPendingThread(thread) && first !== undefined && canUserModifyComment(first, currentUserLogin)
  );
}

/** `:12` or `:12-18`. */
export function lineRangeLabel(thread: Pick<CommentThread, "startLine" | "endLine">): string {
  const { startLine, endLine } = thread;
  return endLine && endLine !== startLine ? `:${startLine}-${endLine}` : `:${startLine}`;
}

/** Threads not yet on GitHub that a submit posts as new review comments. */
export function draftThreadIds(prId: string): string[] {
  return getThreads(prId)
    .filter((t) => draftCommentBody(t, getThreadMessages(prId, t.id)) !== null)
    .map((t) => t.id);
}

/** Threads a submit posts something on: a new comment, or a reply to one GitHub has. */
export function postableThreadCount(prId: string): number {
  return getThreads(prId).filter((t) => {
    const messages = getThreadMessages(prId, t.id);
    return draftCommentBody(t, messages) !== null || pendingReplies(t, messages).length > 0;
  }).length;
}
