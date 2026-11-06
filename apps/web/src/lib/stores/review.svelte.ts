import type {
  AuthorRole,
  CommentThread,
  MessageType,
  ReviewMode,
  ThreadCreatedEnvelope,
  ThreadDeletedEnvelope,
  ThreadMessage,
  ThreadMessageDeletedEnvelope,
  ThreadMessageEditedEnvelope,
  ThreadMessageEnvelope,
  ThreadsNewReplyEnvelope,
  ThreadsSyncedEnvelope,
  ThreadUpdatedEnvelope,
  WalkthroughMode,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { reloadChatForNewHead } from "$lib/chat/turn.svelte";
import { reviewNewCommits } from "$lib/review/review-new-commits";
import { enterSidebarMode } from "$lib/stores/focus-mode.svelte";
import { jsonCodec, readStored, STORAGE_KEYS, writeStored } from "$lib/stores/persisted.svelte";
import { getPrById, getReviewModeForPr, getSelectedPrId } from "$lib/stores/prs.svelte";
import { getSettings, isSettingsLoaded, updateSettings } from "$lib/stores/settings.svelte";
import { refreshPrHead, requestThreadSync } from "$lib/stores/sync.svelte";
import { invalidateForPull, regenerate } from "$lib/stores/walkthrough.svelte";
import type { ReviewFile } from "$lib/types/review";
import { createResource } from "./resource";

// --- Review files (shared between sidebar tree + review page) ---
let reviewFiles = $state<ReviewFile[]>([]);
let isLoadingFiles = $state(false);
let filesError = $state<string | null>(null);

export function getReviewFiles(): ReviewFile[] {
  return reviewFiles;
}

export function getIsLoadingFiles(): boolean {
  return isLoadingFiles;
}

export function getFilesError(): string | null {
  return filesError;
}

export function setReviewFiles(files: ReviewFile[]): void {
  reviewFiles = files;
}

export function setIsLoadingFiles(v: boolean): void {
  isLoadingFiles = v;
}

export function setFilesError(e: string | null): void {
  filesError = e;
}

export function clearReviewFiles(): void {
  reviewFiles = [];
  isLoadingFiles = false;
  filesError = null;
  // `activeFilePath` is owned by the per-PR `prViewStates` record now, so
  // we deliberately don't null it here — `switchPrViewState` already loaded
  // the new PR's saved file path (or `null` for first visits) before this
  // runs. Wiping it would lose that restore.
  clearSession();
}

// --- New-commit-available detection ------------------------------------------
//
// Tracks which git SHA the currently-rendered `reviewFiles[]` correspond to,
// per-PR. When a `prs:updated` SSE event swaps in a new `pr.headSha`, the
// in-memory PR changes but the on-screen diff still reflects the older SHA.
// Comparing `pr.headSha` to the stamped value tells the FloatingTabs dot
// whether to morph into a "Pull" button.
//
// Map reassignment is the Svelte-5 idiom for making a Map reactive — same
// pattern walkthrough.svelte.ts uses for its `entries` map.
let loadedHeadShas = $state(new Map<string, string>());

export function setLoadedHeadSha(prId: string, sha: string): void {
  loadedHeadShas.set(prId, sha);
  loadedHeadShas = new Map(loadedHeadShas);
}

export function getLoadedHeadSha(prId: string): string | null {
  return loadedHeadShas.get(prId) ?? null;
}

/** Concurrent pulls of one PR share a request; `loading` drives the pull button's spinner. */
const pulls = createResource<string, true>({
  fetch: async (prId) =>
    (await runPullLatestCommit(prId))
      ? { status: "ok", data: true }
      : { status: "error", error: "Pull failed" },
});

export function getIsPullingCommit(prId: string): boolean {
  return pulls.entry(prId).loading;
}

/**
 * Refetch the PR's diff files against the current `pr.headSha`, restamp
 * the loaded SHA, and invalidate the walkthrough against the old content.
 * The server's PollScheduler has already invalidated + repopulated its diff
 * cache on SHA change, so the `files.get()` call returns the fresh diff.
 * Coalesces concurrent calls for the same PR and resolves true only when the
 * fresh diff has been installed successfully.
 */
export async function pullLatestCommit(prId: string): Promise<boolean> {
  const request = await pulls.load(prId, prId);
  return request.status === "ok";
}

async function runPullLatestCommit(prId: string): Promise<boolean> {
  try {
    setIsLoadingFiles(true);
    setFilesError(null);

    const activePath = getActiveFilePath();
    const mode = getReviewMode(prId);
    const { data, error } = await api.api.prs({ id: prId }).files.get({
      query: activePath === null ? { mode } : { active: activePath, mode },
    });
    if (error || !Array.isArray(data)) {
      throw new Error(
        error ? apiErrorMessage(error, "Failed to refetch files") : "Failed to refetch files",
      );
    }

    const mapped: ReviewFile[] = data.map((f) => ({
      path: f.path,
      patch: f.patch ?? null,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      ...(f.isNew ? { isNew: true as const } : {}),
      ...(f.isDeleted ? { isDeleted: true as const } : {}),
      ...(f.prerenderedHtml ? { prerenderedHtml: f.prerenderedHtml } : {}),
    }));

    setReviewFiles(mapped);
    // If the user has an active file that's gone in the new diff, fall back
    // to the first file. If the active file still exists, leave it alone so
    // the user's scroll position in the diff tab isn't reset.
    const stillExists = activePath !== null && mapped.some((f) => f.path === activePath);
    if (!stillExists && mapped.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length > 0 guarantees [0] exists
      setActiveFilePath(mapped[0]!.path);
    }

    // Stamp the current PR head SHA. Read from the live PR lists so we pick
    // up whatever `prs:updated` has already merged — even if another
    // `prs:updated` has landed since the UI signalled "new commit available."
    // `getPrById` spans open *and* archived rows: a PR that merged while the
    // page was open has moved to the archive, and missing it here would leave
    // the loaded SHA stamped at the old commit forever (pull button stuck on).
    const pr = getPrById(prId);
    if (pr?.headSha) setLoadedHeadSha(prId, pr.headSha);

    // Invalidate the walkthrough so the user sees the "Generate walkthrough"
    // button and opts in explicitly. This avoids burning tokens on every pull
    // and unblocks the page immediately — we no longer await the SSE stream.
    await invalidateForPull(prId);
    reloadChatForNewHead(prId);
    return true;
  } catch (e) {
    setFilesError(e instanceof Error ? e.message : "Failed to pull latest commit");
    return false;
  } finally {
    setIsLoadingFiles(false);
  }
}

/**
 * Pull the current head through the same path as the tab-side Pull button,
 * then start the incremental walkthrough requested by the superseded toast.
 */
export async function reviewLatestCommit(prId: string, mode: WalkthroughMode): Promise<void> {
  await reviewNewCommits({
    pull: () => pullLatestCommit(prId),
    regenerate: () => regenerate(prId, mode, "incremental"),
  });
}

// --- Session state ---
let sessionId = $state<string | null>(null);
/**
 * The review-session lens for a PR. Derived purely from identity (PR author
 * vs. the signed-in user) via `getReviewModeForPr` — there is no manual
 * override: comments, threads and the diff are keyed on it. The walkthrough's
 * perspective is separate and user-picked; see `getSelectedMode` in the
 * walkthrough store.
 */
export function getReviewMode(prId: string): ReviewMode {
  return getReviewModeForPr(prId);
}

function sessionKeyOf(prId: string, mode: ReviewMode): string {
  return `${prId}:${mode}`;
}

/** The session the threads below belong to, and the one most recently asked for. */
let appliedSessionKey: string | null = null;
let wantedSessionKey: string | null = null;

/**
 * A session hydration stays fresh for a minute, so re-entering a PR doesn't
 * re-read it. Only one session is on screen: applying one forgets the last.
 */
const sessions = createResource<{ prId: string; mode: ReviewMode }, string>({
  freshForMs: 60_000,
  fetch: async (key, { prId, mode }) => {
    const { data, error } = await api.api.reviews.active({ prId }).get({ query: { mode } });
    if (key !== wantedSessionKey) return { status: "error", error: "Superseded" };
    if (error || !data) {
      console.error("[review] Failed to load session:", error);
      toast.error("Failed to load review session");
      return { status: "error", error: "Failed to load review session" };
    }
    const payload = data as {
      session: { id: string; mode?: ReviewMode };
      threads: CommentThread[];
      messages: Record<string, ThreadMessage[]>;
    };
    if (appliedSessionKey !== null && appliedSessionKey !== key) {
      sessions.invalidate(appliedSessionKey);
    }
    appliedSessionKey = key;
    sessionId = payload.session.id;
    threads = payload.threads;
    threadMessages = { ...payload.messages };
    threadsVersion++;
    return { status: "ok", data: payload.session.id };
  },
});

function clearSession(): void {
  sessions.reset();
  appliedSessionKey = null;
  wantedSessionKey = null;
  sessionId = null;
  threads = [];
  threadMessages = {};
  threadsVersion++;
}

/**
 * Load (or create) the active review session for a PR, hydrating all state.
 * Callers that just mutated server state (e.g. submitting a review) pass
 * `force`, otherwise stale local rows (missing the externalId stamped on
 * just-pushed comments) would survive and get re-submitted as duplicates.
 */
export async function loadSession(
  prId: string,
  mode: ReviewMode = getReviewMode(prId),
  force = false,
): Promise<void> {
  const key = sessionKeyOf(prId, mode);
  wantedSessionKey = key;
  const arg = { prId, mode };
  await (force ? sessions.refresh(key, arg) : sessions.load(key, arg));
}

// --- Per-PR view state ---
//
// Single canonical record per PR holding everything that needs to survive a
// PR switch: which tab is active, which file is open, and scroll positions
// for each of the three panes. Treat `prViewStates` as a Map<prId, PrViewState>
// keyed off the PR's id — the user's "PR set with one record per PR".
//
// Mirrored singletons (`activeTab`, `activeFilePath`) are the reactive
// surface read by Svelte components; they're kept in sync with the entry for
// `currentPrId`. Scroll positions are write-only persistence — components
// read them imperatively on mount and write on scroll, no reactivity needed.

/** The review page's tabs, in the order the tab bar shows them (and ⌘1–3 picks them). */
export const REVIEW_TABS = ["conversation", "walkthrough", "diff"] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];
type ActiveTab = ReviewTab;
type ScrollPaneKey = "walkthrough" | "diff" | "conversation" | "sidebar";

interface PrViewState {
  activeTab: ActiveTab;
  activeFilePath: string | null;
  scroll: Partial<Record<ScrollPaneKey, number>>;
}

/** A PR opened for the first time lands here. */
const FIRST_VISIT_TAB: ActiveTab = "conversation";

function emptyState(): PrViewState {
  return { activeTab: FIRST_VISIT_TAB, activeFilePath: null, scroll: {} };
}

// The tab each PR was last left on survives an app restart, so "first
// visit" means first ever, not first since launch. Capped so the record of
// long-closed PRs can't grow forever; oldest visits drop first.
const LAST_TAB_CAP = 300;
const lastTabCodec = jsonCodec((v) =>
  v && typeof v === "object" ? (v as Record<string, string>) : undefined,
);

function rememberLastTab(prId: string, tab: ActiveTab): void {
  const tabs = { ...readStored(STORAGE_KEYS.prLastTab, lastTabCodec, {}) };
  delete tabs[prId];
  tabs[prId] = tab;
  const ids = Object.keys(tabs);
  for (const id of ids.slice(0, Math.max(0, ids.length - LAST_TAB_CAP))) delete tabs[id];
  writeStored(STORAGE_KEYS.prLastTab, lastTabCodec, tabs);
}

function lastTabFor(prId: string): ActiveTab | null {
  const tab = readStored(STORAGE_KEYS.prLastTab, lastTabCodec, {})[prId];
  return REVIEW_TABS.find((known) => known === tab) ?? null;
}

// Single reactive store for per-PR view state. Follows the walkthrough-store
// idiom: entries is a Map keyed by prId; every write is followed by
// reassignment so Svelte 5 tracks it.
const store = $state({
  entries: new Map<string, PrViewState>(),
  activePrId: null as string | null,
});

function getOrCreate(prId: string): PrViewState {
  let s = store.entries.get(prId);
  if (!s) {
    s = emptyState();
    store.entries.set(prId, s);
    store.entries = new Map(store.entries);
  }
  return s;
}

export function getActiveTab(): ActiveTab {
  if (store.activePrId === null) return FIRST_VISIT_TAB;
  return store.entries.get(store.activePrId)?.activeTab ?? FIRST_VISIT_TAB;
}

export function setActiveTab(tab: ActiveTab): void {
  const currentTab = getActiveTab();
  if (tab === currentTab) return;
  // When leaving diff, reset focus-mode to sidebar to prevent stale state
  // when ReviewLayout is destroyed and later recreated
  if (currentTab === "diff") {
    enterSidebarMode();
  }
  // Persist for the current PR
  if (store.activePrId !== null) {
    getOrCreate(store.activePrId).activeTab = tab;
    store.entries = new Map(store.entries);
    rememberLastTab(store.activePrId, tab);
  }
}

export function getActiveFilePath(): string | null {
  if (store.activePrId === null) return null;
  return store.entries.get(store.activePrId)?.activeFilePath ?? null;
}

export function setActiveFilePath(path: string | null): void {
  if (store.activePrId !== null) {
    getOrCreate(store.activePrId).activeFilePath = path;
    store.entries = new Map(store.entries);
  }
}

/** Call when navigating to a PR. Saves state for the previous PR, restores (or defaults) for the new one. */
export function switchPrViewState(newPrId: string): void {
  // Only save current state if we're actually leaving a different PR
  const prevId = store.activePrId;
  if (prevId !== null && prevId !== newPrId) {
    const prev = getOrCreate(prevId);
    prev.activeTab = getActiveTab();
    prev.activeFilePath = getActiveFilePath();
    store.entries = new Map(store.entries);
  }
  store.activePrId = newPrId;
  // Restore saved state, or default for first visit
  const saved = store.entries.get(newPrId);
  const restoredTab = saved?.activeTab ?? lastTabFor(newPrId) ?? FIRST_VISIT_TAB;
  const restoredFilePath = saved?.activeFilePath ?? null;
  // Use direct entry mutation to bypass the guard in setActiveTab (no focus reset needed here)
  if (getActiveTab() === "diff" && restoredTab !== "diff") {
    enterSidebarMode();
  }
  getOrCreate(newPrId).activeTab = restoredTab;
  getOrCreate(newPrId).activeFilePath = restoredFilePath;
  store.entries = new Map(store.entries);
  rememberLastTab(newPrId, restoredTab);
}

// --- Diff scroll reset signal -----------------------------------------------
//
// Monotonic counter bumped whenever the user explicitly selects a file from
// the sidebar tree — even if it's the same file already active. ReviewLayout
// watches this to scroll the diff pane back to the top.
let diffScrollResetSeq = $state(0);

export function getDiffScrollResetSeq(): number {
  return diffScrollResetSeq;
}

export function requestDiffScrollReset(): void {
  diffScrollResetSeq++;
}

// --- Per-PR scroll persistence ---------------------------------------------
//
// Read once on mount (or on the trailing edge of a tab/PR switch); write on
// every scroll event. Components are responsible for plumbing these into the
// right scroll container — see +page.svelte (walkthrough/conversation),
// ReviewLayout.svelte (diff), Sidebar.svelte (sidebar).

export function getPrScrollPosition(prId: string, key: ScrollPaneKey): number {
  return store.entries.get(prId)?.scroll[key] ?? 0;
}

export function setPrScrollPosition(prId: string, key: ScrollPaneKey, value: number): void {
  getOrCreate(prId).scroll[key] = value;
  store.entries = new Map(store.entries);
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

export interface AddThreadParams {
  filePath: string;
  startLine: number;
  endLine: number;
  diffSide: "old" | "new";
  message: {
    authorRole: AuthorRole;
    authorName: string;
    authorLogin?: string | null;
    body: string;
    messageType: MessageType;
    codeSuggestion?: string;
  };
}

/**
 * Create a new comment thread with an initial message.
 * Pessimistic: waits for server to create and return IDs.
 * Returns the created thread and message, or null on error.
 */
export async function addThread(
  params: AddThreadParams,
): Promise<{ thread: CommentThread; message: ThreadMessage } | null> {
  if (!sessionId) {
    console.error("[review] No active session — cannot create thread");
    return null;
  }

  const { data, error } = await api.api.reviews({ id: sessionId }).threads.post({
    filePath: params.filePath,
    startLine: params.startLine,
    endLine: params.endLine,
    diffSide: params.diffSide,
    message: {
      authorRole: params.message.authorRole,
      authorName: params.message.authorName,
      body: params.message.body,
      messageType: params.message.messageType,
      ...(params.message.authorLogin ? { authorLogin: params.message.authorLogin } : {}),
      ...(params.message.codeSuggestion ? { codeSuggestion: params.message.codeSuggestion } : {}),
    },
  });

  if (error || !data) {
    console.error("[review] Failed to create thread:", error);
    return null;
  }

  const result = data as { thread: CommentThread; message: ThreadMessage };

  // Update local state — guard against SSE broadcast arriving first
  if (!threads.some((t) => t.id === result.thread.id)) {
    threads = [...threads, result.thread];
    threadMessages = {
      ...threadMessages,
      [result.thread.id]: [result.message],
    };
    threadsVersion++;
  }

  return result;
}

/**
 * Add a message to an existing thread.
 * Pessimistic: waits for server response.
 */
export async function addThreadMessage(
  threadId: string,
  params: {
    authorRole: AuthorRole;
    authorName: string;
    authorLogin?: string | null;
    body: string;
    messageType: MessageType;
    codeSuggestion?: string;
  },
): Promise<ThreadMessage | null> {
  const { data, error } = await api.api.threads({ id: threadId }).messages.post({
    authorRole: params.authorRole,
    authorName: params.authorName,
    body: params.body,
    messageType: params.messageType,
    ...(params.authorLogin ? { authorLogin: params.authorLogin } : {}),
    ...(params.codeSuggestion ? { codeSuggestion: params.codeSuggestion } : {}),
  });

  if (error || !data) {
    console.error("[review] Failed to add message:", error);
    return null;
  }

  const message = data as ThreadMessage;

  // Guard against SSE broadcast arriving first
  const existing = threadMessages[threadId] ?? [];
  if (!existing.some((m) => m.id === message.id)) {
    threadMessages = {
      ...threadMessages,
      [threadId]: [...existing, message],
    };
  }

  return message;
}

/**
 * Resolve a thread. Optimistic: updates UI immediately, reverts on API failure.
 */
export async function resolveThread(threadId: string): Promise<void> {
  // Optimistic update
  const prevThreads = threads;
  threads = threads.map((t) =>
    t.id === threadId
      ? { ...t, status: "resolved" as const, resolvedAt: new Date().toISOString() }
      : t,
  );
  threadsVersion++;

  const { error } = await api.api.threads({ id: threadId }).patch({ status: "resolved" });

  if (error) {
    console.error("[review] Failed to resolve thread, reverting:", error);
    threads = prevThreads;
    threadsVersion++;
    toast.error("Failed to resolve thread");
  }
}

/**
 * Reopen a resolved thread. Optimistic: updates UI immediately, reverts on API failure.
 */
export async function reopenThread(threadId: string): Promise<void> {
  // Optimistic update
  const prevThreads = threads;
  threads = threads.map((t) =>
    t.id === threadId ? { ...t, status: "open" as const, resolvedAt: null } : t,
  );
  threadsVersion++;

  const { error } = await api.api.threads({ id: threadId }).patch({ status: "open" });

  if (error) {
    console.error("[review] Failed to reopen thread, reverting:", error);
    threads = prevThreads;
    threadsVersion++;
  }
}

export function onThreadUpdated({
  threadId,
  status,
  resolvedAt,
}: ThreadUpdatedEnvelope["data"]): void {
  threads = threads.map((t) => (t.id === threadId ? { ...t, status, resolvedAt } : t));
  threadsVersion++;
}

/** Threads of other sessions (another PR, the other lens) are not on screen. */
export function onThreadCreated({
  sessionId: threadSession,
  thread,
  message,
}: ThreadCreatedEnvelope["data"]): void {
  if (threadSession !== sessionId) return;
  addThreadFromEvent(thread, message);
}

/** A GitHub sync brought in a comment: a new thread, or a reply to a known one. */
export function onThreadsNewReply({ thread, message }: ThreadsNewReplyEnvelope["data"]): void {
  if (thread.reviewSessionId !== sessionId) return;
  addThreadFromEvent(thread, message);
}

function addThreadFromEvent(thread: CommentThread, message: ThreadMessage): void {
  if (!threads.some((t) => t.id === thread.id)) {
    threads = [...threads, thread];
    threadsVersion++;
  }
  // Always add the message if not already present
  const existing = threadMessages[thread.id] ?? [];
  if (!existing.some((m) => m.id === message.id)) {
    threadMessages = {
      ...threadMessages,
      [thread.id]: [...existing, message],
    };
  }
}

export function onThreadMessage({ threadId, message }: ThreadMessageEnvelope["data"]): void {
  // Avoid duplicates
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

// --- Diff view mode ---
// Persisted as `settings.diffViewMode`, so the review toggle and the Settings
// default are one value. The override only covers the window before settings
// load, when there is nothing to merge the optimistic write into yet.
type DiffMode = "unified" | "split";
let diffModeOverride = $state<DiffMode | null>(null);

export function getDiffMode(): DiffMode {
  return diffModeOverride ?? getSettings().diffViewMode;
}

export function setDiffMode(mode: DiffMode): void {
  diffModeOverride = isSettingsLoaded() ? null : mode;
  void updateSettings({ diffViewMode: mode });
}

// --- Pending diff jump ---
interface PendingDiffJump {
  filePath: string;
  lineNumber: number;
}

let pendingDiffJump = $state<PendingDiffJump | null>(null);

export function getPendingDiffJump(): PendingDiffJump | null {
  return pendingDiffJump;
}

export function jumpToDiffLine(filePath: string, lineNumber: number): void {
  pendingDiffJump = { filePath, lineNumber };
  setActiveFilePath(filePath);
  setActiveTab("diff");
}

export function clearPendingDiffJump(): void {
  pendingDiffJump = null;
}

/**
 * Open a changed file in the diff tab, optionally scrolling to a line. Used by
 * clickable file references in the chat panel: with a line we reuse the
 * pending-jump scroll machinery; without one we just select the file and switch
 * tabs. No-ops when the path isn't part of the current review (the file
 * reference resolver only emits known paths, but a stale render could lag a
 * fresh pull). Matches against `oldPath` too so a renamed file still resolves.
 */
export function openFileInDiff(filePath: string, lineNumber?: number): void {
  const match = reviewFiles.find((f) => f.path === filePath || f.oldPath === filePath);
  if (!match) return;
  if (typeof lineNumber === "number") {
    jumpToDiffLine(match.path, lineNumber);
    return;
  }
  setActiveFilePath(match.path);
  setActiveTab("diff");
}

// --- Pending walkthrough-block jump ---
// Mirrors the pending-diff-jump pattern: YourReview (and potentially other
// tabs) can request a scroll to a specific walkthrough block without needing a
// direct ref to the walkthrough's scroll root. GuidedWalkthrough consumes this
// when it becomes active and clears it after scrolling.

let pendingWalkthroughBlockJump = $state<string | null>(null);

export function getPendingWalkthroughBlockJump(): string | null {
  return pendingWalkthroughBlockJump;
}

export function jumpToWalkthroughBlock(blockId: string): void {
  pendingWalkthroughBlockJump = blockId;
  setActiveTab("walkthrough");
}

export function clearPendingWalkthroughBlockJump(): void {
  pendingWalkthroughBlockJump = null;
}

/**
 * Delete a pending (unsynced) thread. Optimistic: removes from local state
 * immediately and reverts on API failure.
 */
export async function deleteThread(threadId: string): Promise<boolean> {
  const prev = threads;
  threads = threads.filter((t) => t.id !== threadId);
  const prevMessages = { ...threadMessages };
  const { [threadId]: _, ...rest } = threadMessages;
  threadMessages = rest;
  threadsVersion++;

  const { error } = await api.api.threads({ id: threadId }).delete();
  if (error) {
    threads = prev;
    threadMessages = prevMessages;
    threadsVersion++;
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

  const prId = store.activePrId;
  if (prId !== null) {
    await loadSession(prId, undefined, true);
  }
  toast.success("Comment sent to GitHub");
  return true;
}

export function onThreadDeleted({ threadId }: ThreadDeletedEnvelope["data"]): void {
  threads = threads.filter((t) => t.id !== threadId);
  const { [threadId]: _, ...rest } = threadMessages;
  threadMessages = rest;
  threadsVersion++;
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
 * Discard a pending (unsynced) reply message on a thread.
 * Optimistic: removes from local state immediately, reverts on API failure.
 * Server enforces that the message is unsynced and isn't the thread's first
 * message — those guards are intentionally duplicated client-side so the
 * Discard button only surfaces when this call is expected to succeed.
 */
export async function deleteThreadMessage(threadId: string, messageId: string): Promise<boolean> {
  const prevMessages = { ...threadMessages };
  const existing = threadMessages[threadId] ?? [];
  threadMessages = {
    ...threadMessages,
    [threadId]: existing.filter((m) => m.id !== messageId),
  };

  const { error } = await api.api.threads({ id: threadId }).messages({ messageId }).delete();

  if (error) {
    threadMessages = prevMessages;
    toast.error("Failed to discard reply");
    return false;
  }
  return true;
}

/**
 * Edit the body of a pending thread's first message.
 * Optimistic: updates UI immediately, reverts on API failure.
 */
export async function editThreadMessage(
  threadId: string,
  messageId: string,
  body: string,
): Promise<boolean> {
  const prev = { ...threadMessages };
  threadMessages = {
    ...threadMessages,
    [threadId]: (threadMessages[threadId] ?? []).map((m) =>
      m.id === messageId ? { ...m, body } : m,
    ),
  };

  const { error } = await api.api.threads({ id: threadId }).messages({ messageId }).patch({ body });
  if (error) {
    threadMessages = prev;
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
  if (prId === getSelectedPrId()) void loadSession(prId, undefined, true);
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
  void loadSession(prId, undefined, true);
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
  clearReviewFiles();
  pulls.reset();
  loadedHeadShas = new Map();
  store.entries = new Map();
  store.activePrId = null;
  pendingDiffJump = null;
  pendingWalkthroughBlockJump = null;
  diffModeOverride = null;
}
