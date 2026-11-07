// The rules the review surfaces apply to comment threads, and what a review
// submit posts from them by the same rules the server applies
// (`@revv/shared` comment-permissions).

import {
  type CommentThread,
  canUserModifyComment,
  draftCommentBody,
  type ThreadMessage,
  unpublishedReplies,
} from "@revv/shared";
import { viewerLoginOnPr } from "$lib/prs/viewer";
import { getThreadMessages, getThreads } from "$lib/stores/review.svelte";

/** Not on GitHub yet: a local draft. */
export function isPendingThread(thread: Pick<CommentThread, "externalCommentId">): boolean {
  return thread.externalCommentId == null;
}

/** A draft the PR's viewer (`viewerLoginOnPr`) may throw away (the server refuses the rest). */
export function canDiscardThread(
  thread: CommentThread,
  messages: readonly ThreadMessage[],
  viewerLogin: string | null,
): boolean {
  const first = messages[0];
  return isPendingThread(thread) && first !== undefined && canUserModifyComment(first, viewerLogin);
}

/** `:12` or `:12-18`. */
export function lineRangeLabel(thread: Pick<CommentThread, "startLine" | "endLine">): string {
  const { startLine, endLine } = thread;
  return endLine && endLine !== startLine ? `:${startLine}-${endLine}` : `:${startLine}`;
}

/** Threads not yet on GitHub that a submit posts as new review comments. */
export function draftThreadIds(prId: string): string[] {
  const viewer = viewerLoginOnPr(prId);
  return getThreads(prId)
    .filter((t) => draftCommentBody(t, getThreadMessages(prId, t.id), viewer) !== null)
    .map((t) => t.id);
}

/** Threads a submit posts something on: a new comment, or a reply to one GitHub has. */
export function postableThreadCount(prId: string): number {
  const viewer = viewerLoginOnPr(prId);
  return getThreads(prId).filter((t) => {
    const messages = getThreadMessages(prId, t.id);
    return (
      draftCommentBody(t, messages, viewer) !== null ||
      unpublishedReplies(t, messages, viewer).length > 0
    );
  }).length;
}
