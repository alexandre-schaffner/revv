// The review of each open PR: its comment threads and their messages.

import type {
  CommentThread,
  ThreadCreatedEnvelope,
  ThreadDeletedEnvelope,
  ThreadMessage,
  ThreadMessageDeletedEnvelope,
  ThreadMessageEditedEnvelope,
  ThreadMessageEnvelope,
  ThreadsLinkedEnvelope,
  ThreadsSyncedEnvelope,
  ThreadUpdatedEnvelope,
} from "@revv/shared";
import { SvelteMap } from "svelte/reactivity";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { thrownMessage } from "$lib/api/wire";
import { refreshPrHead, requestThreadSync } from "$lib/stores/sync.svelte";
import { createResource } from "./resource";

interface PrReview {
  readonly threads: readonly CommentThread[];
  readonly messages: Readonly<Record<string, readonly ThreadMessage[]>>;
}

const EMPTY_REVIEW: PrReview = { threads: [], messages: {} };
const NO_THREADS: readonly CommentThread[] = [];
const NO_MESSAGES: readonly ThreadMessage[] = [];

const reviews = new SvelteMap<string, PrReview>();
/** The PRs whose review is open; a read for a PR released meanwhile is dropped. */
const followed = new Set<string>();

function readReview(prId: string) {
  return call(api.api.reviews.active({ prId }).get(), "Failed to load review session");
}

const loads = createResource<void, true>({
  freshForMs: 60_000,
  fetch: async (prId) => {
    let data: Awaited<ReturnType<typeof readReview>>;
    try {
      data = await readReview(prId);
    } catch (e) {
      if (!followed.has(prId)) return { status: "error", error: "Released" };
      console.error("[review] Failed to load review:", e);
      const message = thrownMessage(e);
      toast.error(message);
      return { status: "error", error: message };
    }
    if (!followed.has(prId)) return { status: "error", error: "Released" };
    reviews.set(prId, { threads: data.threads, messages: { ...data.messages } });
    return { status: "ok", data: true };
  },
});

function review(prId: string): PrReview {
  return reviews.get(prId) ?? EMPTY_REVIEW;
}

function updateReview(prId: string, update: (r: PrReview) => PrReview): void {
  if (!reviews.has(prId)) return;
  reviews.set(prId, update(review(prId)));
}

/** The open PR holding `threadId`, if any. */
function prOfThread(threadId: string): string | null {
  for (const [prId, r] of reviews) {
    if (r.threads.some((t) => t.id === threadId)) return prId;
  }
  return null;
}

function updateThreadReview(threadId: string, update: (r: PrReview) => PrReview): void {
  const prId = prOfThread(threadId);
  if (prId) updateReview(prId, update);
}

function withMessages(
  r: PrReview,
  threadId: string,
  update: (messages: readonly ThreadMessage[]) => readonly ThreadMessage[],
): PrReview {
  return { ...r, messages: { ...r.messages, [threadId]: update(r.messages[threadId] ?? []) } };
}

/**
 * Load a PR's review: every comment thread with its messages. Callers told the
 * server state moved (a pull or a push announced it) pass `force`, otherwise
 * stale local rows (missing the externalId stamped on just-pushed comments)
 * would survive the freshness window and get re-submitted as duplicates.
 */
export async function loadSession(prId: string, force = false): Promise<void> {
  followed.add(prId);
  await (force ? loads.refresh(prId, undefined) : loads.load(prId, undefined));
}

/** Forget the review of `prId`; a read still in flight can't write it back. */
export function releaseSession(prId: string): void {
  followed.delete(prId);
  loads.invalidate(prId);
  reviews.delete(prId);
}

export function getThreads(prId: string): readonly CommentThread[] {
  return reviews.get(prId)?.threads ?? NO_THREADS;
}

export function getThreadsForFile(prId: string, filePath: string): CommentThread[] {
  return getThreads(prId).filter((t) => t.filePath === filePath);
}

export function getThreadMessages(prId: string, threadId: string): readonly ThreadMessage[] {
  return reviews.get(prId)?.messages[threadId] ?? NO_MESSAGES;
}

export interface NewThread {
  filePath: string;
  startLine: number;
  endLine: number;
  diffSide: "old" | "new";
  body: string;
}

function addThreadLocally(prId: string, thread: CommentThread, message: ThreadMessage): void {
  updateReview(prId, (r) => {
    const threads = r.threads.some((t) => t.id === thread.id) ? r.threads : [...r.threads, thread];
    return withMessages({ ...r, threads }, thread.id, (existing) =>
      existing.some((m) => m.id === message.id) ? existing : [...existing, message],
    );
  });
}

/** Start a comment thread on a line range. Pessimistic: waits for the server's ids. */
export async function addThread(prId: string, params: NewThread): Promise<CommentThread | null> {
  let data: { thread: CommentThread; message: ThreadMessage };
  try {
    data = await call(
      api.api.reviews({ id: prId }).threads.post({
        filePath: params.filePath,
        startLine: params.startLine,
        endLine: params.endLine,
        diffSide: params.diffSide,
        message: { body: params.body },
      }),
      "Failed to create thread",
    );
  } catch (e) {
    console.error("[review] Failed to create thread:", e);
    return null;
  }

  // The SSE broadcast may have landed first.
  addThreadLocally(prId, data.thread, data.message);
  return data.thread;
}

function addMessageLocally(threadId: string, message: ThreadMessage): void {
  updateThreadReview(threadId, (r) =>
    withMessages(r, threadId, (existing) =>
      existing.some((m) => m.id === message.id) ? existing : [...existing, message],
    ),
  );
}

/** Reply on a thread. Pessimistic: waits for the server's id. */
export async function addThreadMessage(threadId: string, body: string): Promise<void> {
  let message: ThreadMessage;
  try {
    message = await call(
      api.api.threads({ id: threadId }).messages.post({ body }),
      "Failed to add reply",
    );
  } catch (e) {
    console.error("[review] Failed to add message:", e);
    return;
  }

  // The SSE broadcast may have landed first.
  addMessageLocally(threadId, message);
}

type ThreadStatusFields = Pick<CommentThread, "status" | "resolvedAt">;

function patchThread(threadId: string, fields: ThreadStatusFields): void {
  updateThreadReview(threadId, (r) => ({
    ...r,
    threads: r.threads.map((t) => (t.id === threadId ? { ...t, ...fields } : t)),
  }));
}

function findThread(threadId: string): CommentThread | null {
  const prId = prOfThread(threadId);
  return prId ? (review(prId).threads.find((t) => t.id === threadId) ?? null) : null;
}

/** Optimistic: on failure only this thread's status fields go back. */
async function setThreadStatus(
  threadId: string,
  next: ThreadStatusFields,
  failure: string | null,
): Promise<void> {
  const thread = findThread(threadId);
  if (!thread) return;
  const previous: ThreadStatusFields = { status: thread.status, resolvedAt: thread.resolvedAt };
  patchThread(threadId, next);
  const status = next.status === "open" ? "open" : "resolved";
  try {
    await call(
      api.api.threads({ id: threadId }).patch({ status }),
      failure ?? "Failed to reopen thread",
    );
  } catch (e) {
    console.error(`[review] Failed to set thread ${status}, reverting:`, e);
    patchThread(threadId, previous);
    if (failure) toast.error(thrownMessage(e));
  }
}

export function resolveThread(threadId: string): Promise<void> {
  return setThreadStatus(
    threadId,
    { status: "resolved", resolvedAt: new Date().toISOString() },
    "Failed to resolve thread",
  );
}

export function reopenThread(threadId: string): Promise<void> {
  return setThreadStatus(threadId, { status: "open", resolvedAt: null }, null);
}

export function onThreadUpdated({
  threadId,
  status,
  resolvedAt,
}: ThreadUpdatedEnvelope["data"]): void {
  patchThread(threadId, { status, resolvedAt });
}

export function onThreadCreated({ prId, thread, message }: ThreadCreatedEnvelope["data"]): void {
  addThreadLocally(prId, thread, message);
}

/** A new message; a changed one comes as `thread:message:edited`. */
export function onThreadMessage({ threadId, message }: ThreadMessageEnvelope["data"]): void {
  addMessageLocally(threadId, message);
}

function removeThreadLocally(threadId: string): void {
  updateThreadReview(threadId, (r) => {
    const { [threadId]: _, ...messages } = r.messages;
    return { threads: r.threads.filter((t) => t.id !== threadId), messages };
  });
}

/**
 * Delete a pending (unsynced) thread. Optimistic: on failure the thread and
 * its messages come back where they were, unless an event re-added them.
 */
export async function deleteThread(threadId: string): Promise<boolean> {
  const prId = prOfThread(threadId);
  const before = prId ? review(prId) : null;
  const index = before?.threads.findIndex((t) => t.id === threadId) ?? -1;
  const thread = before?.threads[index];
  const messages = before?.messages[threadId];
  removeThreadLocally(threadId);

  try {
    await call(api.api.threads({ id: threadId }).delete(), "Failed to discard comment");
  } catch (e) {
    if (prId && thread) {
      updateReview(prId, (r) => {
        if (r.threads.some((t) => t.id === threadId)) return r;
        const threads = [...r.threads.slice(0, index), thread, ...r.threads.slice(index)];
        return messages
          ? { threads, messages: { ...r.messages, [threadId]: messages } }
          : { ...r, threads };
      });
    }
    toast.error(thrownMessage(e));
    return false;
  }
  return true;
}

/** Push one local draft comment to GitHub as the account that owns the PR's repository. */
export async function pushThreadToGitHub(threadId: string): Promise<boolean> {
  try {
    await call(api.api.threads({ id: threadId }).push.post(), "Failed to send comment to GitHub");
  } catch (e) {
    toast.error(thrownMessage(e));
    return false;
  }
  // The server announces `threads:linked` once the thread is linked; the
  // re-read it triggers makes the posted draft read-only.
  toast.success("Comment sent to GitHub");
  return true;
}

export function onThreadDeleted({ threadId }: ThreadDeletedEnvelope["data"]): void {
  removeThreadLocally(threadId);
}

export function onThreadMessageEdited({
  threadId,
  message,
}: ThreadMessageEditedEnvelope["data"]): void {
  updateThreadReview(threadId, (r) =>
    withMessages(r, threadId, (existing) =>
      existing.map((m) => (m.id === message.id ? message : m)),
    ),
  );
}

export function onThreadMessageDeleted({
  threadId,
  messageId,
}: ThreadMessageDeletedEnvelope["data"]): void {
  updateThreadReview(threadId, (r) =>
    withMessages(r, threadId, (existing) => existing.filter((m) => m.id !== messageId)),
  );
}

/**
 * Discard a pending (unsynced) reply message on a thread. Optimistic: on
 * failure the message comes back where it was. The server refuses a synced
 * message or a thread's first one; the Discard button applies the same rules
 * so it only shows when this is expected to succeed.
 */
export async function deleteThreadMessage(threadId: string, messageId: string): Promise<boolean> {
  const prId = prOfThread(threadId);
  const existing = prId ? (review(prId).messages[threadId] ?? []) : [];
  const index = existing.findIndex((m) => m.id === messageId);
  const message = existing[index];
  onThreadMessageDeleted({ threadId, messageId });

  try {
    await call(
      api.api.threads({ id: threadId }).messages({ messageId }).delete(),
      "Failed to discard reply",
    );
  } catch (e) {
    if (message) {
      updateThreadReview(threadId, (r) =>
        withMessages(r, threadId, (current) =>
          current.some((m) => m.id === messageId)
            ? current
            : [...current.slice(0, index), message, ...current.slice(index)],
        ),
      );
    }
    toast.error(thrownMessage(e));
    return false;
  }
  return true;
}

function setMessageBody(threadId: string, messageId: string, body: string): void {
  updateThreadReview(threadId, (r) =>
    withMessages(r, threadId, (existing) =>
      existing.map((m) => (m.id === messageId ? { ...m, body } : m)),
    ),
  );
}

/** Edit the body of a pending thread's first message. Optimistic: on failure the old body comes back. */
export async function editThreadMessage(
  threadId: string,
  messageId: string,
  body: string,
): Promise<boolean> {
  const prId = prOfThread(threadId);
  const previous = prId
    ? review(prId).messages[threadId]?.find((m) => m.id === messageId)?.body
    : undefined;
  setMessageBody(threadId, messageId, body);

  try {
    await call(
      api.api.threads({ id: threadId }).messages({ messageId }).patch({ body }),
      "Failed to save edit",
    );
  } catch (e) {
    if (previous !== undefined) setMessageBody(threadId, messageId, previous);
    toast.error(thrownMessage(e));
    return false;
  }
  return true;
}

/**
 * The server only emits this when the pull actually moved something (or the
 * user asked for the sync), so an open review re-reads its session even
 * inside the freshness window.
 */
export function onThreadsSynced({ prId }: ThreadsSyncedEnvelope["data"]): void {
  if (followed.has(prId)) void loadSession(prId, true);
}

export function onThreadsLinked({ prId }: ThreadsLinkedEnvelope["data"]): void {
  if (followed.has(prId)) void loadSession(prId, true);
}

/**
 * Thread events sent while the stream was down are gone. The session read is
 * DB-only, so each open review also asks GitHub for its threads and its head
 * (a dropped connection may have hidden a push).
 */
export function onEventsReconnected(): void {
  for (const prId of followed) {
    requestThreadSync(prId);
    void loadSession(prId, true);
    refreshPrHead(prId);
  }
}

/**
 * Coming back to the window is when the user may have pushed from a terminal,
 * and a DB read can't see a commit the poll fiber hasn't fetched yet.
 */
export function onWindowForeground(): void {
  for (const prId of followed) refreshPrHead(prId);
}

export function reset(): void {
  followed.clear();
  loads.reset();
  reviews.clear();
}
