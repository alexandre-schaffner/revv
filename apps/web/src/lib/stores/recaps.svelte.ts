import type {
  ProjectRecap,
  ProjectRecapStatus,
  ProjectRecapSummary,
  RecapPeriod,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";

// ── State ────────────────────────────────────────────────────────────────────

/**
 * Recap summaries per repository, keyed by `repositoryId`. Each entry is
 * ordered newest → oldest by `generatedAt`. The detail row (`overview` etc.)
 * isn't carried here — it's fetched on demand via `loadRecap`.
 */
let recapsByRepo = $state<Map<string, ProjectRecapSummary[]>>(new Map());
let nextCursorByRepo = $state<Map<string, string | null>>(new Map());
let loadingByRepo = $state<Map<string, boolean>>(new Map());

/** Full recap (markdown + provenance + stats), keyed by `recapId`. */
let recapDetailById = $state<Map<string, ProjectRecap>>(new Map());
let loadingDetailById = $state<Map<string, boolean>>(new Map());

/** Selected recap, used by the detail view. */
let selectedRecapId = $state<string | null>(null);

// ── Getters ──────────────────────────────────────────────────────────────────

export function getRecapsForRepo(repoId: string): ProjectRecapSummary[] {
  return recapsByRepo.get(repoId) ?? [];
}

export function getRecapNextCursor(repoId: string): string | null {
  return nextCursorByRepo.get(repoId) ?? null;
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

export function getSelectedRecapId(): string | null {
  return selectedRecapId;
}

export function setSelectedRecapId(id: string | null): void {
  selectedRecapId = id;
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
      nextCursorByRepo = setEntry(nextCursorByRepo, repoId, page.nextCursor);
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to load recaps");
  } finally {
    loadingByRepo = setEntry(loadingByRepo, repoId, false);
  }
}

export async function fetchMoreRecapsForRepo(repoId: string): Promise<void> {
  const cursor = nextCursorByRepo.get(repoId);
  if (!cursor) return;
  if (loadingByRepo.get(repoId)) return;
  loadingByRepo = setEntry(loadingByRepo, repoId, true);
  try {
    const { data } = await api.api.repos({ id: repoId }).recaps.get({ query: { cursor } });
    if (data) {
      const page = data as {
        recaps: ProjectRecapSummary[];
        nextCursor: string | null;
      };
      const existing = recapsByRepo.get(repoId) ?? [];
      const existingIds = new Set(existing.map((r) => r.id));
      const fresh = page.recaps.filter((r) => !existingIds.has(r.id));
      recapsByRepo = setEntry(recapsByRepo, repoId, [...existing, ...fresh]);
      nextCursorByRepo = setEntry(nextCursorByRepo, repoId, page.nextCursor);
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to load more recaps");
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
  try {
    const { data, error } = await api.api.recaps({ id: recapId }).regenerate.post();
    if (error) throw new Error(`HTTP ${error.status}`);
    return data as { recapId: string } | null;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to regenerate recap");
    return null;
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
  completedAt?: string;
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

export function reset(): void {
  recapsByRepo = new Map();
  nextCursorByRepo = new Map();
  loadingByRepo = new Map();
  recapDetailById = new Map();
  loadingDetailById = new Map();
  selectedRecapId = null;
}
