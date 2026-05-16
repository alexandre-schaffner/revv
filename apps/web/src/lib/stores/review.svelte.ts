import type {
  AuthorRole,
  CommentThread,
  HunkDecision,
  MessageType,
  ThreadMessage,
  ThreadStatus,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { invalidateChatHistory } from "$lib/stores/chat.svelte";
import { enterSidebarMode } from "$lib/stores/focus-mode.svelte";
import { getPullRequests } from "$lib/stores/prs.svelte";
import { invalidateForPull } from "$lib/stores/walkthrough-stream.svelte";
import type { ReviewFile } from "$lib/types/review";
import { RequestState, type RequestState as RequestStateType } from "$lib/stores/_types";

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
  clearRepoFile();
  clearSession();
}

// --- Unchanged-file content viewer ------------------------------------------
//
// When the user clicks a file in the sidebar repo tree that ISN'T part of the
// PR's diff, we still want the main pane to show something useful: the file's
// content at the PR's head SHA. The endpoint reads from the local clone via
// `git cat-file`, so this is fast and rate-limit-free.

type RepoFileData =
  | { readonly status: "ready"; readonly content: string; readonly size: number }
  | { readonly status: "binary"; readonly size: number }
  | { readonly status: "too-large"; readonly size: number }
  | { readonly status: "not-found"; readonly size: number };

let repoFile = $state<RequestStateType<RepoFileData>>(RequestState.idle());
let repoFilePath = $state<string | null>(null);

export function getRepoFile(): RequestStateType<RepoFileData> {
  return repoFile;
}
export function getRepoFilePath(): string | null {
  return repoFilePath;
}

export function clearRepoFile(): void {
  repoFile = RequestState.idle();
  repoFilePath = null;
}

let repoFileLoadSeq = 0;

/**
 * Fetch the contents of a single file at the PR's head SHA. Skip-noop if
 * the same path was just loaded; otherwise transitions through 'loading'
 * to one of the terminal states.
 */
export async function loadRepoFile(prId: string, path: string): Promise<void> {
  if (repoFilePath === path && repoFile.status !== "idle" && repoFile.status !== "error") {
    return;
  }
  const seq = ++repoFileLoadSeq;
  repoFile = RequestState.loading();
  repoFilePath = path;

  try {
    const { data, error, status } = await api.api
      .prs({ id: prId })
      ["repo-file"].get({ query: { path } });

    if (seq !== repoFileLoadSeq) return;

    if (error || !data) {
      const body = (error?.value ?? null) as {
        status?: string;
        message?: string;
        size?: number;
      } | null;
      if (body?.status === "cloning" || status === 202) {
        repoFile = RequestState.loading();
        return;
      }
      if (body?.status === "not-found" || status === 404) {
        repoFile = RequestState.ok({ status: "not-found", size: 0 });
        return;
      }
      if (body?.status === "too-large" || status === 413) {
        repoFile = RequestState.ok({
          status: "too-large",
          size: typeof body?.size === "number" ? body.size : 0,
        });
        return;
      }
      repoFile = RequestState.error(body?.message ?? "Failed to load file");
      return;
    }

    const payload = data as
      | {
          status: "ready";
          headSha: string;
          path: string;
          content: string;
          isBinary: boolean;
          size: number;
        }
      | { status: "cloning" }
      | { status: "not-found"; size: number }
      | { status: "too-large"; size: number }
      | { status: "error"; message: string };

    if (payload.status === "cloning") {
      repoFile = RequestState.loading();
      return;
    }
    if (payload.status === "not-found") {
      repoFile = RequestState.ok({ status: "not-found", size: 0 });
      return;
    }
    if (payload.status === "too-large") {
      repoFile = RequestState.ok({ status: "too-large", size: payload.size });
      return;
    }
    if (payload.status === "error") {
      repoFile = RequestState.error(payload.message);
      return;
    }

    // status === 'ready'
    if (payload.isBinary) {
      repoFile = RequestState.ok({ status: "binary", size: payload.size });
    } else {
      repoFile = RequestState.ok({ status: "ready", content: payload.content, size: payload.size });
    }
  } catch (e) {
    if (seq !== repoFileLoadSeq) return;
    repoFile = RequestState.error(e instanceof Error ? e.message : "Failed to load file");
  }
}

// --- New-commit-available detection ------------------------------------------
//
// Tracks which git SHA the currently-rendered `reviewFiles[]` correspond to,
// per-PR. When a `prs:updated` WebSocket event swaps in a new `pr.headSha`, the
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

// Per-PR in-flight flag so the pull button can show a spinner without
// racing a second click. Set-reassignment for reactivity, matching the
// loadedHeadShas pattern above.
let isPullingCommit = $state(new Set<string>());

export function getIsPullingCommit(prId: string): boolean {
  return isPullingCommit.has(prId);
}

/**
 * Refetch the PR's diff files against the current `pr.headSha`, restamp
 * the loaded SHA, and regenerate the walkthrough against the new content.
 * The server's PollScheduler has already invalidated + repopulated its diff
 * cache on SHA change, so the `files.get()` call returns the fresh diff.
 * Coalesces concurrent calls for the same PR.
 */
export async function pullLatestCommit(prId: string): Promise<void> {
  if (isPullingCommit.has(prId)) return;
  isPullingCommit.add(prId);
  isPullingCommit = new Set(isPullingCommit);

  try {
    setIsLoadingFiles(true);
    setFilesError(null);

    const { data, error } = await api.api.prs({ id: prId }).files.get();
    if (error || !Array.isArray(data)) {
      throw new Error("Failed to refetch files");
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
    const activePath = getActiveFilePath();
    const stillExists = activePath !== null && mapped.some((f) => f.path === activePath);
    if (!stillExists && mapped.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length > 0 guarantees [0] exists
      setActiveFilePath(mapped[0]!.path);
    }

    // Stamp the current PR head SHA. Read from the live PR list so we pick
    // up whatever `prs:updated` has already merged — even if another
    // `prs:updated` has landed since the UI signalled "new commit available."
    const pr = getPullRequests().find((p) => p.id === prId);
    if (pr?.headSha) setLoadedHeadSha(prId, pr.headSha);

    // Invalidate the walkthrough so the user sees the "Generate walkthrough"
    // button and opts in explicitly. This avoids burning tokens on every pull
    // and unblocks the page immediately — we no longer await the SSE stream.
    await invalidateForPull(prId);
    invalidateChatHistory(prId);
  } catch (e) {
    setFilesError(e instanceof Error ? e.message : "Failed to pull latest commit");
  } finally {
    setIsLoadingFiles(false);
    isPullingCommit.delete(prId);
    isPullingCommit = new Set(isPullingCommit);
  }
}

// --- Session state ---
let sessionId = $state<string | null>(null);
let sessionLoading = $state(false);

export function getSessionId(): string | null {
  return sessionId;
}

export function getSessionLoading(): boolean {
  return sessionLoading;
}

function clearSession(): void {
  sessionId = null;
  threads = [];
  threadMessages = {};
  acceptedHunks = new Map();
  rejectedHunks = new Map();
  threadsVersion++;
  // Reset the short-circuit window too — an explicit clear means callers
  // want a fresh hydration on the next `loadSession` call.
  lastSessionPrId = null;
  lastSessionAt = 0;
}

let loadSessionSeq = 0;

// Phase 1 stopgap: skip redundant session loads when the same PR was hydrated
// within the last minute AND we still have a live session id. Phase 3's
// queryStore replaces this with per-key cache semantics.
let lastSessionPrId: string | null = null;
let lastSessionAt = 0;
const SESSION_REFETCH_WINDOW_MS = 60_000;

/** Load (or create) the active review session for a PR, hydrating all state. */
export async function loadSession(prId: string): Promise<void> {
  // Short-circuit: same PR, recent hydration, session still live.
  if (
    prId === lastSessionPrId &&
    Date.now() - lastSessionAt < SESSION_REFETCH_WINDOW_MS &&
    sessionId !== null
  ) {
    return;
  }

  const seq = ++loadSessionSeq;
  sessionLoading = true;
  try {
    const { data, error } = await api.api.reviews.active({ prId }).get();

    // Discard if a newer call has started
    if (seq !== loadSessionSeq) return;

    if (error || !data) {
      console.error("[review] Failed to load session:", error);
      toast.error("Failed to load review session");
      return;
    }

    // Type-narrow: the response is the full hydration payload
    const payload = data as {
      session: { id: string };
      threads: CommentThread[];
      messages: Record<string, ThreadMessage[]>;
      hunkDecisions: HunkDecision[];
    };

    sessionId = payload.session.id;
    threads = payload.threads;

    // Populate thread messages
    const msgs: Record<string, ThreadMessage[]> = {};
    for (const [tid, msgList] of Object.entries(payload.messages)) {
      msgs[tid] = msgList;
    }
    threadMessages = msgs;

    // Rebuild hunk decision Maps
    const accepted = new Map<string, Set<number>>();
    const rejected = new Map<string, Set<number>>();
    for (const hd of payload.hunkDecisions) {
      const map = hd.decision === "accepted" ? accepted : rejected;
      const set = map.get(hd.filePath) ?? new Set<number>();
      set.add(hd.hunkIndex);
      map.set(hd.filePath, set);
    }
    acceptedHunks = accepted;
    rejectedHunks = rejected;
    threadsVersion++;
    lastSessionPrId = prId;
    lastSessionAt = Date.now();
  } finally {
    // Only clear loading if this is still the active request
    if (seq === loadSessionSeq) {
      sessionLoading = false;
    }
  }
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

type ActiveTab = "walkthrough" | "diff" | "request-changes";
type ScrollPaneKey = "walkthrough" | "diff" | "requestChanges" | "sidebar";

interface PrViewState {
  activeTab: ActiveTab;
  activeFilePath: string | null;
  scroll: Partial<Record<ScrollPaneKey, number>>;
}

function emptyState(): PrViewState {
  return { activeTab: "walkthrough", activeFilePath: null, scroll: {} };
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
  if (store.activePrId === null) return "walkthrough";
  return store.entries.get(store.activePrId)?.activeTab ?? "walkthrough";
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
  const restoredTab = saved?.activeTab ?? "walkthrough";
  const restoredFilePath = saved?.activeFilePath ?? null;
  // Use direct entry mutation to bypass the guard in setActiveTab (no focus reset needed here)
  if (getActiveTab() === "diff" && restoredTab !== "diff") {
    enterSidebarMode();
  }
  getOrCreate(newPrId).activeTab = restoredTab;
  getOrCreate(newPrId).activeFilePath = restoredFilePath;
  store.entries = new Map(store.entries);
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
// right scroll container — see +page.svelte (walkthrough/requestChanges),
// ReviewLayout.svelte (diff), Sidebar.svelte (sidebar), RightPanel.svelte
// (rightPanel).

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
    authorAvatarUrl?: string | null;
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
    message: params.message,
  });

  if (error || !data) {
    console.error("[review] Failed to create thread:", error);
    return null;
  }

  const result = data as { thread: CommentThread; message: ThreadMessage };

  // Update local state — guard against WS broadcast arriving first
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
    authorAvatarUrl?: string | null;
    body: string;
    messageType: MessageType;
    codeSuggestion?: string;
  },
): Promise<ThreadMessage | null> {
  const { data, error } = await api.api.threads({ id: threadId }).messages.post(params);

  if (error || !data) {
    console.error("[review] Failed to add message:", error);
    return null;
  }

  const message = data as ThreadMessage;

  // Guard against WS broadcast arriving first
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

/**
 * Update a thread's status from a WebSocket message (no API call needed).
 */
export function onThreadUpdated(threadId: string, status: ThreadStatus): void {
  const isResolved = status === "resolved" || status === "wont_fix";
  threads = threads.map((t) =>
    t.id === threadId
      ? {
          ...t,
          status,
          resolvedAt: isResolved ? new Date().toISOString() : null,
        }
      : t,
  );
  threadsVersion++;
}

/**
 * Push a thread and message from a WebSocket broadcast (no API call needed).
 */
export function onThreadCreated(thread: CommentThread, message: ThreadMessage): void {
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

/**
 * Push a message from a WebSocket broadcast (no API call needed).
 */
export function onThreadMessage(threadId: string, message: ThreadMessage): void {
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
type DiffMode = "unified" | "split";
let diffMode = $state<DiffMode>("unified");

export function getDiffMode(): DiffMode {
  return diffMode;
}

export function setDiffMode(mode: DiffMode): void {
  diffMode = mode;
}

// --- Panel open request (cross-component signal) ---
let panelOpenRequested = $state(false);

export function requestPanelOpen(): void {
  panelOpenRequested = true;
}

export function getPanelOpenRequested(): boolean {
  return panelOpenRequested;
}

export function consumePanelOpenRequest(): void {
  panelOpenRequested = false;
}

// --- Hunk accept/reject ---
// Tracks reviewer's accept/reject decisions per file.
// Accepted hunks are approved; rejected hunks are flagged for the coder.
let acceptedHunks = $state<Map<string, Set<number>>>(new Map());
let rejectedHunks = $state<Map<string, Set<number>>>(new Map());

export function getAcceptedHunks(filePath: string): Set<number> {
  const existing = acceptedHunks.get(filePath);
  return existing ?? new Set();
}

export function getRejectedHunks(filePath: string): Set<number> {
  const existing = rejectedHunks.get(filePath);
  return existing ?? new Set();
}

async function setHunkDecision(
  filePath: string,
  hunkIndex: number,
  decision: "accepted" | "rejected",
): Promise<void> {
  // Optimistic update
  const prevAccepted = new Map(acceptedHunks);
  const prevRejected = new Map(rejectedHunks);

  const opposite = decision === "accepted" ? rejectedHunks : acceptedHunks;
  const own = decision === "accepted" ? acceptedHunks : rejectedHunks;

  // Remove from the opposite map if present
  const oppSet = new Set(opposite.get(filePath) ?? []);
  if (oppSet.delete(hunkIndex)) {
    const next = new Map(opposite);
    next.set(filePath, oppSet);
    if (decision === "accepted") rejectedHunks = next;
    else acceptedHunks = next;
  }

  // Add to own map
  const ownNext = new Map(own);
  const ownSet = new Set(ownNext.get(filePath) ?? []);
  ownSet.add(hunkIndex);
  ownNext.set(filePath, ownSet);
  if (decision === "accepted") acceptedHunks = ownNext;
  else rejectedHunks = ownNext;

  // Persist
  if (sessionId) {
    const { error } = await api.api.reviews({ id: sessionId }).hunks.put({
      filePath,
      hunkIndex,
      decision,
    });
    if (error) {
      console.error(`[review] Failed to persist hunk ${decision}, reverting:`, error);
      acceptedHunks = prevAccepted;
      rejectedHunks = prevRejected;
      toast.error("Failed to save hunk decision");
    }
  }
}

export async function acceptHunk(filePath: string, hunkIndex: number): Promise<void> {
  return setHunkDecision(filePath, hunkIndex, "accepted");
}

export async function rejectHunk(filePath: string, hunkIndex: number): Promise<void> {
  return setHunkDecision(filePath, hunkIndex, "rejected");
}

export async function undoHunkAction(filePath: string, hunkIndex: number): Promise<void> {
  // Optimistic update
  const prevAccepted = new Map(acceptedHunks);
  const prevRejected = new Map(rejectedHunks);

  const nextA = new Map(acceptedHunks);
  const nextR = new Map(rejectedHunks);
  const aSet = new Set(nextA.get(filePath) ?? []);
  const rSet = new Set(nextR.get(filePath) ?? []);
  aSet.delete(hunkIndex);
  rSet.delete(hunkIndex);
  nextA.set(filePath, aSet);
  nextR.set(filePath, rSet);
  acceptedHunks = nextA;
  rejectedHunks = nextR;

  // Persist
  if (sessionId) {
    const { error } = await api.api
      .reviews({ id: sessionId })
      .hunks({ filePath: encodeURIComponent(filePath) })({ hunkIndex: String(hunkIndex) })
      .delete();
    if (error) {
      console.error("[review] Failed to persist hunk undo, reverting:", error);
      acceptedHunks = prevAccepted;
      rejectedHunks = prevRejected;
    }
  }
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

// --- Pending walkthrough-block jump ---
// Mirrors the pending-diff-jump pattern: RequestChanges (and potentially other
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

/**
 * Remove a thread from local state in response to a WebSocket broadcast.
 */
export function onThreadDeleted(threadId: string): void {
  threads = threads.filter((t) => t.id !== threadId);
  const { [threadId]: _, ...rest } = threadMessages;
  threadMessages = rest;
  threadsVersion++;
}

/**
 * Update a message body from a WebSocket broadcast (no API call needed).
 */
export function onThreadMessageEdited(threadId: string, message: ThreadMessage): void {
  threadMessages = {
    ...threadMessages,
    [threadId]: (threadMessages[threadId] ?? []).map((m) => (m.id === message.id ? message : m)),
  };
}

/**
 * Remove a message from local state in response to a WebSocket broadcast.
 */
export function onThreadMessageDeleted(threadId: string, messageId: string): void {
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
