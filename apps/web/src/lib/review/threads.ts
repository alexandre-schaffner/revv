// The rules the review surfaces apply to comment threads, and what a review
// submit posts from them by the same rules the server applies
// (`@revv/shared` comment-permissions).

import {
  type CommentThread,
  canUserModifyComment,
  draftCommentBody,
  isPublishableDraftComment,
  messagesInReview,
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

/** What a review submit posts on one thread, as the review dialog lists it. */
export interface PostableThread {
  readonly thread: CommentThread;
  /** A new review comment, or replies on a thread GitHub already has. */
  readonly kind: "comment" | "reply";
  /** The drafts that go up, in order: one comment's parts, or each reply. */
  readonly messages: readonly ThreadMessage[];
  /** The text GitHub receives: the joined comment, or each reply. */
  readonly bodies: readonly string[];
}

/**
 * The threads a submit with `issueIds` chosen posts something on, by the
 * server's rules: a draft thread as a new review comment (Revv's comment on
 * an issue only with that issue), a thread GitHub has with the viewer's
 * pending replies. In file and line order.
 */
export function postableThreads(prId: string, issueIds: ReadonlySet<string>): PostableThread[] {
  const viewer = viewerLoginOnPr(prId);
  const out: PostableThread[] = [];
  for (const thread of getThreads(prId)) {
    const carried = messagesInReview(thread, getThreadMessages(prId, thread.id), issueIds);
    const body = draftCommentBody(thread, carried, viewer);
    if (body !== null) {
      const messages = carried.filter((m) => isPublishableDraftComment(m, viewer));
      out.push({ thread, kind: "comment", messages, bodies: [body] });
      continue;
    }
    const replies = unpublishedReplies(thread, carried, viewer);
    if (replies.length > 0) {
      out.push({ thread, kind: "reply", messages: replies, bodies: replies.map((m) => m.body) });
    }
  }
  return out.sort(
    (a, b) =>
      a.thread.filePath.localeCompare(b.thread.filePath) || a.thread.startLine - b.thread.startLine,
  );
}
