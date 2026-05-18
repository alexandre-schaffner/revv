import type {
  ProjectRecap,
  ProjectRecapStatus,
  ProjectRecapSummary,
  RecapPeriod,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { abortRecapStream } from "$lib/stores/recap-stream.svelte";

// ── State ────────────────────────────────────────────────────────────────────

/**
 * Recap summaries per repository, keyed by `repositoryId`. Each entry is
 * ordered newest → oldest by `generatedAt`. The detail row (`overview` etc.)
 * isn't carried here — it's fetched on demand via `loadRecap`.
 */
let recapsByRepo = $state<Map<string, ProjectRecapSummary[]>>(new Map());
let loadingByRepo = $state<Map<string, boolean>>(new Map());

/** Full recap (markdown + provenance + stats), keyed by `recapId`. */
let recapDetailById = $state<Map<string, ProjectRecap>>(new Map());
let loadingDetailById = $state<Map<string, boolean>>(new Map());

// In-flight destructive actions keyed by recapId. Drives the `disabled`
// state on the floating Stop / Resume / Retry / Regenerate buttons so a
// double-click can't fire two concurrent actions during the async
// POST → stream-restart dance. Same shape as walkthrough's pending-action
// map; mutations follow the Map-reassignment idiom enforced elsewhere.
export type RecapPendingAction = "stop" | "regenerate";

const pendingActions = $state({
  map: new Map<string, RecapPendingAction>(),
});

function setPending(recapId: string, action: RecapPendingAction): void {
  pendingActions.map.set(recapId, action);
  pendingActions.map = new Map(pendingActions.map);
}

function clearPending(recapId: string): void {
  if (!pendingActions.map.has(recapId)) return;
  pendingActions.map.delete(recapId);
  pendingActions.map = new Map(pendingActions.map);
}

/**
 * In-flight destructive action for the given recap, or null. Consumed by
 * the RecapDetail floating bar to disable buttons during the async dance
 * after the user clicks one.
 */
export function getRecapPendingAction(recapId: string): RecapPendingAction | null {
  return pendingActions.map.get(recapId) ?? null;
}

// ── Getters ──────────────────────────────────────────────────────────────────

export function getRecapsForRepo(repoId: string): ProjectRecapSummary[] {
  return recapsByRepo.get(repoId) ?? [];
}

export function getRecapLoading(repoId: string): boolean {
  return loadingByRepo.get(repoId) ?? false;
}

export function getRecapDetail(recapId: string): ProjectRecap | null {
  return recapDetailById.get(recapId) ?? null;
}

export function getRecapDetailLoading(recapId: string): boolean {
  return loadingDetailById.get(recapId) ?? false;
}

// ── Map-write helpers (per §4 conventions — reassign after Map.set) ─────────

function setEntry<K, V>(map: Map<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function updateEntry<K, V>(
  map: Map<K, V>,
  key: K,
  updater: (current: V | undefined) => V,
): Map<K, V> {
  const current = map.get(key);
  const next = new Map(map);
  next.set(key, updater(current));
  return next;
}

// ── List fetches ─────────────────────────────────────────────────────────────

export async function fetchRecapsForRepo(repoId: string): Promise<void> {
  if (loadingByRepo.get(repoId)) return;
  loadingByRepo = setEntry(loadingByRepo, repoId, true);
  try {
    const { data } = await api.api.repos({ id: repoId }).recaps.get({ query: {} });
    if (data) {
      const page = data as {
        recaps: ProjectRecapSummary[];
        nextCursor: string | null;
      };
      recapsByRepo = setEntry(recapsByRepo, repoId, page.recaps);
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to load recaps");
  } finally {
    loadingByRepo = setEntry(loadingByRepo, repoId, false);
  }
}

export async function loadRecap(recapId: string): Promise<void> {
  if (loadingDetailById.get(recapId)) return;
  loadingDetailById = setEntry(loadingDetailById, recapId, true);
  try {
    const { data } = await api.api.recaps({ id: recapId }).get();
    if (data) {
      recapDetailById = setEntry(recapDetailById, recapId, data as ProjectRecap);
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to load recap");
  } finally {
    loadingDetailById = setEntry(loadingDetailById, recapId, false);
  }
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function generateRecap(
  repoId: string,
  period: RecapPeriod,
  options?: { regenerate?: boolean; periodStart?: string; periodEnd?: string },
): Promise<{ recapId: string } | null> {
  try {
    const body: { period: RecapPeriod; periodStart?: string; periodEnd?: string } = {
      period,
    };
    if (options?.periodStart !== undefined) body.periodStart = options.periodStart;
    if (options?.periodEnd !== undefined) body.periodEnd = options.periodEnd;
    const query = options?.regenerate ? { regenerate: "true" } : {};
    const { data, error } = await api.api
      .repos({ id: repoId })
      .recaps.generate.post(body, { query });
    if (error) throw new Error(`HTTP ${error.status}`);
    if (data) {
      // Refresh the list so the new placeholder row appears.
      void fetchRecapsForRepo(repoId);
      return data as { recapId: string };
    }
    return null;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to start recap");
    return null;
  }
}

export async function regenerateRecap(recapId: string): Promise<{ recapId: string } | null> {
  if (pendingActions.map.has(recapId)) return null;
  setPending(recapId, "regenerate");
  try {
    const { data, error } = await api.api.recaps({ id: recapId }).regenerate.post();
    if (error) throw new Error(`HTTP ${error.status}`);
    return data as { recapId: string } | null;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to regenerate recap");
    return null;
  } finally {
    clearPending(recapId);
  }
}

/**
 * Stop an in-flight recap generation. Aborts the client SSE immediately
 * (so the UI stops painting) and hits the server cancel endpoint so the
 * agent stops burning tokens. The server transitions the row to
 * `status='error'` with `errorMessage="Cancelled by user"`, broadcasts
 * the change via WS, and the reducer here patches the cached detail/list
 * state on receipt. Returns true on success.
 */
export async function stopRecap(recapId: string): Promise<boolean> {
  if (pendingActions.map.has(recapId)) return false;
  setPending(recapId, "stop");
  try {
    abortRecapStream(recapId);
    const { error } = await api.api.recaps({ id: recapId }).stop.post();
    if (error) throw new Error(`HTTP ${error.status}`);
    return true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to stop recap");
    return false;
  } finally {
    clearPending(recapId);
  }
}

// ── WebSocket reducers ──────────────────────────────────────────────────────

/**
 * Patch the status of a recap in both the summary list (if loaded) and
 * the detail cache (if loaded). New status arrives via the
 * `recap:status-changed` envelope.
 */
export function onRecapStatusChanged(data: {
  recapId: string;
  repoId: string;
  period: RecapPeriod;
  status: ProjectRecapStatus;
  completedAt?: string | null;
  errorMessage?: string | null;
}): void {
  // List: in-place patch the status column.
  recapsByRepo = updateEntry(recapsByRepo, data.repoId, (current) => {
    const list = current ?? [];
    const idx = list.findIndex((r) => r.id === data.recapId);
    if (idx < 0) return list;
    const row = list[idx];
    if (!row) return list;
    const patched: ProjectRecapSummary = {
      ...row,
      status: data.status,
      ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
      ...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
    };
    return [...list.slice(0, idx), patched, ...list.slice(idx + 1)];
  });

  // Detail: same patch if we have it cached.
  const existing = recapDetailById.get(data.recapId);
  if (existing) {
    const patched: ProjectRecap = {
      ...existing,
      status: data.status,
      ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
      ...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
    };
    recapDetailById = setEntry(recapDetailById, data.recapId, patched);
  }
}

/**
 * Insert (or replace) a recap row from a `recap:added` envelope. Used for
 * both freshly-generated rows and completion broadcasts (which carry the
 * full row so the UI can render markdown without re-fetching).
 */
export function onRecapAdded(data: { recap: ProjectRecap }): void {
  const recap = data.recap;

  // Cache the detail.
  recapDetailById = setEntry(recapDetailById, recap.id, recap);

  // Patch the summary list. If we don't have an entry for this repo loaded
  // yet, skip — `fetchRecapsForRepo` will pick the row up on next load.
  const list = recapsByRepo.get(recap.repositoryId);
  if (!list) return;
  const summary: ProjectRecapSummary = {
    id: recap.id,
    repositoryId: recap.repositoryId,
    period: recap.period,
    periodStart: recap.periodStart,
    periodEnd: recap.periodEnd,
    status: recap.status,
    generatedAt: recap.generatedAt,
    completedAt: recap.completedAt,
    sourcePrCount: recap.sourcePrIds.length,
    summaryStats: recap.summaryStats,
    errorMessage: recap.errorMessage,
  };
  const idx = list.findIndex((r) => r.id === recap.id);
  if (idx >= 0) {
    recapsByRepo = updateEntry(recapsByRepo, recap.repositoryId, () => [
      ...list.slice(0, idx),
      summary,
      ...list.slice(idx + 1),
    ]);
    return;
  }
  // Newest-first ordering — insert at the position that keeps the list
  // sorted by generatedAt DESC.
  const insertAt = list.findIndex((r) => r.generatedAt < summary.generatedAt);
  recapsByRepo = updateEntry(recapsByRepo, recap.repositoryId, () => {
    if (insertAt < 0) return [...list, summary];
    return [...list.slice(0, insertAt), summary, ...list.slice(insertAt)];
  });
}
