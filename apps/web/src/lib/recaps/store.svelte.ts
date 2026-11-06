import type {
  ProjectRecap,
  ProjectRecapStatus,
  ProjectRecapSummary,
  RecapPeriod,
} from "@revv/shared";
import { recapSummaryOf } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { createResource } from "$lib/stores/resource";
import { monthGridRange } from "./period-window";
import { abortRecapStream } from "./stream.svelte";

// ── State ────────────────────────────────────────────────────────────────────

/**
 * Recap summaries per repository, keyed by `repositoryId`. Each entry is
 * ordered newest → oldest by `generatedAt`. The detail row (`overview` etc.)
 * isn't carried here — it's fetched on demand via `loadRecap`.
 *
 * Semantics: this is **every summary we've loaded**, not "the first page".
 * The calendar fetches arbitrary historical grids by month, so both fetch
 * paths merge into this one map rather than replacing it. A parallel
 * by-month slice would force both SSE reducers to patch two structures
 * consistently, for no benefit.
 *
 * Consequence: a row the server later excludes (it became `superseded`)
 * lingers here until reload. Mostly handled already — `onRecapStatusChanged`
 * patches the status on broadcast and every consumer filters
 * `status !== "superseded"` — and any new consumer must do the same.
 * Tombstone tracking isn't worth it for a local desktop app.
 */
let recapsByRepo = $state<Map<string, ProjectRecapSummary[]>>(new Map());

/** Full recap (markdown + provenance + stats), keyed by `recapId`. */
let recapDetailById = $state<Map<string, ProjectRecap>>(new Map());

// The three reads below only schedule fetches; what they read merges into the
// maps above, which SSE reducers patch too.

/** A repo's newest page of summaries. */
const repoReads = createResource<void, true>({ fetch: (repoId) => readRepoRecaps(repoId) });

/** A calendar month's grid, by `repoId:monthKey`; a loaded month stays loaded. */
const monthReads = createResource<{ readonly repoId: string; readonly monthKey: string }, true>({
  fetch: (_key, { repoId, monthKey }) => readMonthRecaps(repoId, monthKey),
  freshForMs: Number.POSITIVE_INFINITY,
});

const detailReads = createResource<void, true>({ fetch: (recapId) => readRecap(recapId) });

function monthCacheKey(repoId: string, monthKey: string): string {
  return `${repoId}:${monthKey}`;
}

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
  return repoReads.entry(repoId).loading;
}

/** True while the calendar grid for this month is being fetched. */
export function getMonthRecapsLoading(repoId: string, monthKey: string): boolean {
  return monthReads.entry(monthCacheKey(repoId, monthKey)).loading;
}

export function getRecapDetail(recapId: string): ProjectRecap | null {
  return recapDetailById.get(recapId) ?? null;
}

export function getRecapDetailLoading(recapId: string): boolean {
  return detailReads.entry(recapId).loading;
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

/**
 * Upsert `incoming` into `current` by `id` (incoming wins), then re-sort
 * `generatedAt` DESC to preserve the list invariant every consumer relies on.
 */
function mergeSummaries(
  current: readonly ProjectRecapSummary[],
  incoming: readonly ProjectRecapSummary[],
): ProjectRecapSummary[] {
  const byId = new Map(current.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
}

export async function fetchRecapsForRepo(repoId: string): Promise<void> {
  await repoReads.load(repoId);
}

async function readRepoRecaps(repoId: string) {
  try {
    const { data, error } = await api.api.repos({ id: repoId }).recaps.get({ query: {} });
    if (error) throw new Error(apiErrorMessage(error, "Failed to load recaps"));
    // Merge, don't replace. `generateRecap` calls this on every trigger,
    // and a replace would wipe every historical month the calendar has
    // loaded the instant the user generates anything.
    recapsByRepo = updateEntry(recapsByRepo, repoId, (cur) =>
      mergeSummaries(cur ?? [], data.recaps),
    );
    return { status: "ok", data: true } as const;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load recaps";
    toast.error(message);
    return { status: "error", error: message } as const;
  }
}

/**
 * Fetch every recap whose window falls inside a calendar month's 6×7 grid and
 * merge it into {@link recapsByRepo}. Idempotent: a month already loaded or in
 * flight is a no-op, so the calendar's prefetch effects can fire freely.
 *
 * `limit: "100"` (`MAX_RECAP_PAGE_LIMIT` on the server) is load-bearing, not
 * defensive. The default page limit is 30, but a 42-day grid can hold 42 daily
 * + 6 weekly = 48 rows. At the default the server would silently truncate and
 * hand back a `nextCursor` this caller has nowhere to put — so the calendar
 * would show phantom gaps. One page always suffices at 100.
 *
 * Unlike {@link fetchRecapsForRepo} this never raises a toast: it runs as a
 * background prefetch of adjacent months, and a failed warm-up must not throw
 * an error at a user who didn't ask for anything. A failed month is asked
 * again by a later navigation.
 */
export async function fetchRecapsForMonth(repoId: string, monthKey: string): Promise<void> {
  await monthReads.load(monthCacheKey(repoId, monthKey), { repoId, monthKey });
}

async function readMonthRecaps(repoId: string, monthKey: string) {
  try {
    const { from, to } = monthGridRange(monthKey);
    const { data, error } = await api.api
      .repos({ id: repoId })
      .recaps.get({ query: { from, to, limit: "100" } });
    if (error) {
      return { status: "error", error: apiErrorMessage(error, "No recaps returned") } as const;
    }
    recapsByRepo = updateEntry(recapsByRepo, repoId, (cur) =>
      mergeSummaries(cur ?? [], data.recaps),
    );
    return { status: "ok", data: true } as const;
  } catch (e) {
    console.warn(`[recaps] failed to load ${monthKey} for repo ${repoId}`, e);
    return { status: "error", error: String(e) } as const;
  }
}

/**
 * Fetch the recap row. `force` reads it again after a load in flight: that
 * one may have left before the state the caller is reconciling against was
 * committed.
 */
export async function loadRecap(recapId: string, options?: { force?: boolean }): Promise<void> {
  await (options?.force ? detailReads.refresh(recapId) : detailReads.load(recapId));
}

async function readRecap(recapId: string) {
  try {
    const { data, error } = await api.api.recaps({ id: recapId }).get();
    if (error) throw new Error(apiErrorMessage(error, "Failed to load recap"));
    recapDetailById = setEntry(recapDetailById, recapId, data);
    return { status: "ok", data: true } as const;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load recap";
    toast.error(message);
    return { status: "error", error: message } as const;
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
    if (error) throw new Error(apiErrorMessage(error, "Failed to start recap"));
    // Refresh the list so the new placeholder row appears.
    void fetchRecapsForRepo(repoId);
    return data;
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
    if (error) throw new Error(apiErrorMessage(error, "Failed to regenerate recap"));
    return data;
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
 * agent stops burning tokens. The server moves the row to `stopped` and
 * broadcasts it; the local patch below just doesn't wait for that.
 * Returns true on success.
 */
export async function stopRecap(recapId: string): Promise<boolean> {
  if (pendingActions.map.has(recapId)) return false;
  setPending(recapId, "stop");
  try {
    abortRecapStream(recapId);
    const { error } = await api.api.recaps({ id: recapId }).stop.post();
    if (error) throw new Error(apiErrorMessage(error, "Failed to stop recap"));
    // The server broadcasts the stop too; the UI doesn't wait for it.
    patchRecapStatus(recapId, null, { status: "stopped", errorMessage: null, completedAt: null });
    return true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to stop recap");
    return false;
  } finally {
    clearPending(recapId);
  }
}

// ── SSE event reducers ──────────────────────────────────────────────────────

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
  patchRecapStatus(data.recapId, data.repoId, {
    status: data.status,
    ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
    ...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
  });
}

type StatusPatch = Pick<ProjectRecapSummary, "status"> &
  Partial<Pick<ProjectRecapSummary, "completedAt" | "errorMessage">>;

/**
 * Patch a recap's status in its repository's summary list and in the detail
 * cache, wherever either is loaded. `repoId` null: the recap's repository is
 * looked up in what is loaded.
 */
function patchRecapStatus(recapId: string, repoId: string | null, patch: StatusPatch): void {
  const owner =
    repoId ??
    recapDetailById.get(recapId)?.repositoryId ??
    [...recapsByRepo].find(([, list]) => list.some((r) => r.id === recapId))?.[0] ??
    null;
  if (owner !== null) {
    recapsByRepo = updateEntry(recapsByRepo, owner, (current) =>
      (current ?? []).map((row) => (row.id === recapId ? { ...row, ...patch } : row)),
    );
  }
  const existing = recapDetailById.get(recapId);
  if (existing) recapDetailById = setEntry(recapDetailById, recapId, { ...existing, ...patch });
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
  const summary = recapSummaryOf(recap);
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
  recapDetailById = new Map();
  repoReads.reset();
  monthReads.reset();
  detailReads.reset();
  pendingActions.map = new Map();
}
