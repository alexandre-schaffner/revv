// The comment threads of one diff file as Pierre annotations: the PR's review
// threads on it, the one open "new comment" input, and the thread being
// replied to. A viewer creates one and hands it to its Pierre renderer.

import type { DiffLineAnnotation } from "@pierre/diffs";
import type { CommentThread, ThreadMessage } from "@revv/shared";
import type { DiffLineRange, DiffSide } from "$lib/pierre/diff-rows";
import { isPendingThread } from "$lib/review/threads";
import {
  addThread,
  addThreadMessage,
  deleteThread,
  deleteThreadMessage,
  editThreadMessage,
  getThreadMessages,
  getThreadsForFile,
  pushThreadToGitHub,
  reopenThread,
  resolveThread,
} from "$lib/stores/review.svelte";
import type { ThreadMeta } from "./pierre-diff-adapter";

export class ThreadAnnotations {
  readonly #prId: () => string;
  readonly #filePath: () => string;
  /**
   * The open new-comment input; it sits on `startLine` and covers through
   * `endLine`. It stays with its file while another file is shown.
   */
  #input = $state<(DiffLineRange & { filePath: string }) | null>(null);
  #replyingThreadId = $state<string | null>(null);
  /** The last comment trigger acted on, so a remounted viewer doesn't replay it. */
  #handledTriggerSeq = 0;

  constructor(prId: () => string, filePath: () => string) {
    this.#prId = prId;
    this.#filePath = filePath;
  }

  // Every thread write replaces the PR's review entry, so these re-derive and
  // hand Pierre fresh metadata objects; it caches annotations by reference.
  #threads(): CommentThread[] {
    return getThreadsForFile(this.#prId(), this.#filePath());
  }

  readonly annotations: DiffLineAnnotation<ThreadMeta>[] = $derived.by(() => {
    const out: DiffLineAnnotation<ThreadMeta>[] = this.#threads().map((thread) => ({
      side: thread.diffSide === "old" ? "deletions" : "additions",
      lineNumber: thread.startLine,
      metadata: {
        threadId: thread.id,
        isInputActive: false,
        isReplying: this.#replyingThreadId === thread.id,
        isPending: isPendingThread(thread),
      },
    }));
    const input = this.#currentInput();
    if (input) {
      out.push({
        side: input.side,
        lineNumber: input.startLine,
        metadata: { threadId: "", isInputActive: true, isReplying: false, isPending: false },
      });
    }
    return out;
  });

  readonly threadById: Record<string, CommentThread> = $derived.by(() =>
    Object.fromEntries(this.#threads().map((t) => [t.id, t])),
  );

  readonly threadMessages: Record<string, readonly ThreadMessage[]> = $derived.by(() =>
    Object.fromEntries(this.#threads().map((t) => [t.id, getThreadMessages(this.#prId(), t.id)])),
  );

  #currentInput(): DiffLineRange | null {
    const input = this.#input;
    return input?.filePath === this.#filePath() ? input : null;
  }

  claimTrigger(seq: number): boolean {
    if (seq <= this.#handledTriggerSeq) return false;
    this.#handledTriggerSeq = seq;
    return true;
  }

  /** Open the new-comment input over `range`, replacing any other. */
  openInput(range: DiffLineRange): void {
    this.#input = { ...range, filePath: this.#filePath() };
  }

  /** A click on a line opens its input, or closes it when it's already open there. */
  toggleInputAt(side: DiffSide, lineNumber: number): void {
    const input = this.#currentInput();
    if (input?.side === side && input.startLine === lineNumber) this.#input = null;
    else this.openInput({ side, startLine: lineNumber, endLine: lineNumber });
  }

  dismissInput(): void {
    this.#input = null;
  }

  async submitComment(body: string): Promise<void> {
    const input = this.#currentInput();
    if (!input) return;
    this.#input = null;
    await addThread(this.#prId(), {
      filePath: this.#filePath(),
      startLine: input.startLine,
      endLine: input.endLine,
      diffSide: input.side === "deletions" ? "old" : "new",
      body,
    });
  }

  toggleReply(threadId: string): void {
    this.#replyingThreadId = this.#replyingThreadId === threadId ? null : threadId;
  }

  async submitReply(threadId: string, body: string): Promise<void> {
    this.#replyingThreadId = null;
    await addThreadMessage(threadId, body);
  }

  readonly resolve = resolveThread;
  readonly reopen = reopenThread;
  readonly discard = deleteThread;
  readonly discardReply = deleteThreadMessage;
  readonly editMessage = editThreadMessage;
  readonly push = pushThreadToGitHub;
}
