// The review of the PR on screen: its comment threads and their messages.
// Only one PR's review is on screen at a time.

import type {
  CommentThread,
  ThreadCreatedEnvelope,
  ThreadDeletedEnvelope,
  ThreadMessage,
  ThreadMessageDeletedEnvelope,
  ThreadMessageEditedEnvelope,
  ThreadMessageEnvelope,
  ThreadsSyncedEnvelope,
  ThreadUpdatedEnvelope,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { getUser } from "$lib/stores/auth.svelte";
import { getSelectedPrId } from "$lib/stores/route.svelte";
import { refreshPrHead, requestThreadSync } from "$lib/stores/sync.svelte";
import { createResource } from "./resource";

/** The PR whose threads are on screen, and the one most recently asked for. */
let shownPrId: string | null = null;
let wantedPrId: string | null = null;

/** A review read stays fresh for a minute, so re-entering a PR doesn't re-read it. */
const reviews = createResource<string, true>({
  freshForMs: 60_000,
  fetch: async (prId) => {
    const { data, error } = await api.api.reviews.active({ prId }).get();
    if (prId !== wantedPrId) return { status: "error", error: "Superseded" };
    if (error) {
      console.error("[review] Failed to load review:", error);
      toast.error("Failed to load review session");
      return { status: "error", error: "Failed to load review session" };
    }
    if (shownPrId !== null && shownPrId !== prId) reviews.invalidate(shownPrId);
    shownPrId = prId;
    threads = data.threads;
    threadMessages = { ...data.messages };
    threadsVersion++;
    return { status: "ok", data: true };
  },
});

function dropShownReview(): void {
  shownPrId = null;
  threads = [];
  threadMessages = {};
  threadsVersion++;
}

/** Forget every review; a read still in flight can't write back. */
export function clearSession(): void {
  reviews.reset();
  wantedPrId = null;
  dropShownReview();
}

/**
 * Load a PR's review: every comment thread with its messages. Another PR's
 * threads leave the screen at once. Callers that just mutated server state
 * (e.g. submitting a review) pass `force`, otherwise stale local rows (missing
 * the externalId stamped on just-pushed comments) would survive and get
 * re-submitted as duplicates.
 */
export async function loadSession(prId: string, force = false): Promise<void> {
  if (shownPrId !== null && shownPrId !== prId) dropShownReview();
  wantedPrId = prId;
  await (force ? reviews.refresh(prId, prId) : reviews.load(prId, prId));
}

// --- Comment threads ---
let threads = $state<CommentThread[]>([]);
let threadMessages = $state<Record<string, ThreadMessage[]>>({});
// Monotonic counter bumped on every thread mutation. Consumed inside reactive
// derivations that need to force-recompute (e.g. DiffViewer's annotations),
// because @pierre/diffs caches annotations by metadata reference.
let threadsVersion = $state(0);

export function getThreadsVersion(): number {
  return threadsVersion;
}

export function getThreads(): CommentThread[] {
  return threads;
}

export function getThreadMessages(threadId: string): ThreadMessage[] {
  return threadMessages[threadId] ?? [];
}

/** Comments written in Revv are the signed-in reviewer's. */
function reviewerAuthor(): { authorRole: "reviewer"; authorName: string; authorLogin?: string } {
  const user = getUser();
  const login = user?.githubLogin ?? null;
  return {
    authorRole: "reviewer",
    authorName: login ?? user?.name ?? "You",
    ...(login ? { authorLogin: login } : {}),
  };
}

export interface NewThread {
  filePath: string;
  startLine: number;
  endLine: number;
  diffSide: "old" | "new";
  body: string;
}

/**
 * Start a comment thread on a line range. Pessimistic: waits for the server's
 * ids. Returns null when no PR is on screen or the server refused.
 */
export async function addThread(params: NewThread): Promise<CommentThread | null> {
  if (!shownPrId) {
    console.error("[review] No review on screen — cannot create thread");
    return null;
  }

  const { data, error } = await api.api.reviews({ id: shownPrId }).threads.post({
    filePath: params.filePath,
    startLine: params.startLine,
    endLine: params.endLine,
    diffSide: params.diffSide,
    message: { ...reviewerAuthor(), body: params.body, messageType: "comment" },
  });

  if (error) {
    console.error("[review] Failed to create thread:", error);
    return null;
  }

  const { thread, message } = data;
  // The SSE broadcast may have landed first.
  if (!threads.some((t) => t.id === thread.id)) {
    threads = [...threads, thread];
    threadMessages = { ...threadMessages, [thread.id]: [message] };
    threadsVersion++;
  }
  return thread;
}

/** Reply on a thread. Pessimistic: waits for the server's id. */
export async function addThreadMessage(threadId: string, body: string): Promise<void> {
  const { data, error } = await api.api
    .threads({ id: threadId })
    .messages.post({ ...reviewerAuthor(), body, messageType: "reply" });

  if (error) {
    console.error("[review] Failed to add message:", error);
    return;
  }

  // The SSE broadcast may have landed first.
  const existing = threadMessages[threadId] ?? [];
  if (!existing.some((m) => m.id === data.id)) {
    threadMessages = { ...threadMessages, [threadId]: [...existing, data] };
  }
}

type ThreadStatusFields = Pick<CommentThread, "status" | "resolvedAt">;

function patchThread(threadId: string, fields: ThreadStatusFields): void {
  threads = threads.map((t) => (t.id === threadId ? { ...t, ...fields } : t));
  threadsVersion++;
}

/** Optimistic: on failure only this thread's status fields go back. */
async function setThreadStatus(
  threadId: string,
  next: ThreadStatusFields,
  failure: string | null,
): Promise<void> {
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return;
  const previous: ThreadStatusFields = { status: thread.status, resolvedAt: thread.resolvedAt };
  patchThread(threadId, next);
  const status = next.status === "open" ? "open" : "resolved";
  const { error } = await api.api.threads({ id: threadId }).patch({ status });
  if (error) {
    console.error(`[review] Failed to set thread ${status}, reverting:`, error);
    patchThread(threadId, previous);
    if (failure) toast.error(failure);
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
  threads = threads.map((t) => (t.id === threadId ? { ...t, status, resolvedAt } : t));
  threadsVersion++;
}

/** Another PR's threads are not on screen. */
export function onThreadCreated({ prId, thread, message }: ThreadCreatedEnvelope["data"]): void {
  if (prId !== shownPrId) return;
  if (!threads.some((t) => t.id === thread.id)) {
    threads = [...threads, thread];
    threadsVersion++;
  }
  const existing = threadMessages[thread.id] ?? [];
  if (!existing.some((m) => m.id === message.id)) {
    threadMessages = { ...threadMessages, [thread.id]: [...existing, message] };
  }
}

/** A new message; a changed one comes as `thread:message:edited`. Another PR's threads are not on screen. */
export function onThreadMessage({ threadId, message }: ThreadMessageEnvelope["data"]): void {
  if (!threads.some((t) => t.id === threadId)) return;
  const existing = threadMessages[threadId] ?? [];
  if (existing.some((m) => m.id === message.id)) return;
  threadMessages = {
    ...threadMessages,
    [threadId]: [...existing, message],
  };
}

export function getThreadsForFile(filePath: string): CommentThread[] {
  return threads.filter((t) => t.filePath === filePath);
}

function removeThreadLocally(threadId: string): void {
  threads = threads.filter((t) => t.id !== threadId);
  const { [threadId]: _, ...rest } = threadMessages;
  threadMessages = rest;
  threadsVersion++;
}

/**
 * Delete a pending (unsynced) thread. Optimistic: on failure the thread and
 * its messages come back where they were, unless an event re-added them.
 */
export async function deleteThread(threadId: string): Promise<boolean> {
  const index = threads.findIndex((t) => t.id === threadId);
  const thread = threads[index];
  const messages = threadMessages[threadId];
  removeThreadLocally(threadId);

  const { error } = await api.api.threads({ id: threadId }).delete();
  if (error) {
    if (thread && !threads.some((t) => t.id === threadId)) {
      threads = [...threads.slice(0, index), thread, ...threads.slice(index)];
      if (messages) threadMessages = { ...threadMessages, [threadId]: messages };
      threadsVersion++;
    }
    toast.error("Failed to discard comment");
    return false;
  }
  return true;
}

/** Push one local draft comment to GitHub under the active account's identity. */
export async function pushThreadToGitHub(threadId: string): Promise<boolean> {
  const { error } = await api.api.threads({ id: threadId }).push.post();
  if (error) {
    toast.error("Failed to send comment to GitHub");
    return false;
  }

  if (shownPrId !== null) await loadSession(shownPrId, true);
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
  threadMessages = {
    ...threadMessages,
    [threadId]: (threadMessages[threadId] ?? []).map((m) => (m.id === message.id ? message : m)),
  };
}

export function onThreadMessageDeleted({
  threadId,
  messageId,
}: ThreadMessageDeletedEnvelope["data"]): void {
  const existing = threadMessages[threadId];
  if (!existing) return;
  threadMessages = {
    ...threadMessages,
    [threadId]: existing.filter((m) => m.id !== messageId),
  };
}

/**
 * Discard a pending (unsynced) reply message on a thread. Optimistic: on
 * failure the message comes back where it was. The server refuses a synced
 * message or a thread's first one; the Discard button applies the same rules
 * so it only shows when this is expected to succeed.
 */
export async function deleteThreadMessage(threadId: string, messageId: string): Promise<boolean> {
  const existing = threadMessages[threadId] ?? [];
  const index = existing.findIndex((m) => m.id === messageId);
  const message = existing[index];
  threadMessages = {
    ...threadMessages,
    [threadId]: existing.filter((m) => m.id !== messageId),
  };

  const { error } = await api.api.threads({ id: threadId }).messages({ messageId }).delete();

  if (error) {
    const current = threadMessages[threadId];
    if (message && current && !current.some((m) => m.id === messageId)) {
      threadMessages = {
        ...threadMessages,
        [threadId]: [...current.slice(0, index), message, ...current.slice(index)],
      };
    }
    toast.error("Failed to discard reply");
    return false;
  }
  return true;
}

function setMessageBody(threadId: string, messageId: string, body: string): void {
  threadMessages = {
    ...threadMessages,
    [threadId]: (threadMessages[threadId] ?? []).map((m) =>
      m.id === messageId ? { ...m, body } : m,
    ),
  };
}

/** Edit the body of a pending thread's first message. Optimistic: on failure the old body comes back. */
export async function editThreadMessage(
  threadId: string,
  messageId: string,
  body: string,
): Promise<boolean> {
  const previous = threadMessages[threadId]?.find((m) => m.id === messageId)?.body;
  setMessageBody(threadId, messageId, body);

  const { error } = await api.api.threads({ id: threadId }).messages({ messageId }).patch({ body });
  if (error) {
    if (previous !== undefined) setMessageBody(threadId, messageId, previous);
    toast.error("Failed to save edit");
    return false;
  }
  return true;
}

/**
 * Apply the suggestion from a comment thread's first message.
 * Replaces content with the suggested code.
 */
export async function applyCommentSuggestion(threadId: string, suggestion: string): Promise<void> {
  const messages = threadMessages[threadId];
  if (!messages || messages.length === 0) return;

  const updated = messages.map((msg, i) =>
    i === 0 ? { ...msg, codeSuggestion: suggestion } : msg,
  );
  threadMessages = { ...threadMessages, [threadId]: updated };

  // Resolve the thread
  await resolveThread(threadId);
}

/**
 * The server only emits this when the pull actually moved something (or the
 * user asked for the sync), so the PR on screen re-reads its session even
 * inside the freshness window.
 */
export function onThreadsSynced({ prId }: ThreadsSyncedEnvelope["data"]): void {
  if (prId === getSelectedPrId()) void loadSession(prId, true);
}

/**
 * Thread events sent while the stream was down are gone. The session read is
 * DB-only, so the PR on screen also asks GitHub for its threads and its head
 * (a dropped connection may have hidden a push).
 */
export function onEventsReconnected(): void {
  const prId = getSelectedPrId();
  if (!prId) return;
  requestThreadSync(prId);
  void loadSession(prId, true);
  refreshPrHead(prId);
}

/**
 * Coming back to the window is when the user may have pushed from a terminal,
 * and a DB read can't see a commit the poll fiber hasn't fetched yet.
 */
export function onWindowForeground(): void {
  const prId = getSelectedPrId();
  if (prId) refreshPrHead(prId);
}

export function reset(): void {
  clearSession();
}
