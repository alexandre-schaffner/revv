import type {
  ProjectRecap,
  ProjectRecapStatus,
  ProjectRecapSummary,
  RecapPeriod,
} from "@revv/shared";
import { MAX_RECAP_PAGE_LIMIT, recapSummaryOf } from "@revv/shared";
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { thrownMessage } from "$lib/api/wire";
import { createResource } from "$lib/stores/resource";
import { monthGridRange } from "./period-window";
import { abortRecapStream } from "./stream.svelte";

/**
 * Recap summaries per repository, newest `generatedAt` first: every summary
 * loaded so far (the calendar loads arbitrary historical months), not one
 * page. A row leaves as soon as it is superseded.
 */
let recapsByRepo = $state<Map<string, ProjectRecapSummary[]>>(new Map());

let recapDetailById = $state<Map<string, ProjectRecap>>(new Map());

/** A repo's newest page of summaries. */
const repoReads = createResource<void, true>({ fetch: (repoId) => readRepoRecaps(repoId) });

const monthReads = createResource<{ readonly repoId: string; readonly monthKey: string }, true>({
  fetch: (_key, { repoId, monthKey }) => readMonthRecaps(repoId, monthKey),
  freshForMs: Number.POSITIVE_INFINITY,
});

const detailReads = createResource<void, true>({ fetch: (recapId) => readRecap(recapId) });

function monthCacheKey(repoId: string, monthKey: string): string {
  return `${repoId}:${monthKey}`;
}

// Disables the floating Stop / Regenerate buttons while one is in flight, so a
// double-click can't fire two concurrent actions.
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

export function getRecapPendingAction(recapId: string): RecapPendingAction | null {
  return pendingActions.map.get(recapId) ?? null;
}

function getRecapsForRepo(repoId: string): ProjectRecapSummary[] {
  return recapsByRepo.get(repoId) ?? [];
}

function getRecapLoading(repoId: string): boolean {
  return repoReads.entry(repoId).loading;
}

export function getMonthRecapsLoading(repoId: string, monthKey: string): boolean {
  return monthReads.entry(monthCacheKey(repoId, monthKey)).loading;
}

export function getRecapDetail(recapId: string): ProjectRecap | null {
  return recapDetailById.get(recapId) ?? null;
}

export function getRecapDetailLoading(recapId: string): boolean {
  return detailReads.entry(recapId).loading;
}

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

function mergeSummaries(
  current: readonly ProjectRecapSummary[],
  incoming: readonly ProjectRecapSummary[],
): ProjectRecapSummary[] {
  const byId = new Map(current.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()]
    .filter((r) => r.status !== "superseded")
    .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
}

async function fetchRecapsForRepo(repoId: string): Promise<void> {
  await repoReads.load(repoId);
}

async function readRepoRecaps(repoId: string) {
  try {
    const data = await call(
      api.api.repos({ id: repoId }).recaps.get({ query: {} }),
      "Failed to load recaps",
    );
    // Merge, don't replace: this runs on every generate, and replacing would
    // drop every historical month the calendar has loaded.
    recapsByRepo = updateEntry(recapsByRepo, repoId, (cur) =>
      mergeSummaries(cur ?? [], data.recaps),
    );
    return { status: "ok", data: true } as const;
  } catch (e) {
    const message = thrownMessage(e);
    toast.error(message);
    return { status: "error", error: message } as const;
  }
}

/**
 * Fetch every recap whose window falls inside a calendar month's 6×7 grid. A
 * month already loaded or in flight is a no-op, so prefetches can fire freely.
 * It asks for the largest page: at the server's default limit a grid's rows
 * would be truncated, with a `nextCursor` this caller has nowhere to put.
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
    const data = await call(
      api.api
        .repos({ id: repoId })
        .recaps.get({ query: { from, to, limit: String(MAX_RECAP_PAGE_LIMIT) } }),
      "No recaps returned",
    );
    recapsByRepo = updateEntry(recapsByRepo, repoId, (cur) =>
      mergeSummaries(cur ?? [], data.recaps),
    );
    return { status: "ok", data: true } as const;
  } catch (e) {
    console.warn(`[recaps] failed to load ${monthKey} for repo ${repoId}`, e);
    return { status: "error", error: thrownMessage(e) } as const;
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
    const data = await call(api.api.recaps({ id: recapId }).get(), "Failed to load recap");
    recapDetailById = setEntry(recapDetailById, recapId, data);
    return { status: "ok", data: true } as const;
  } catch (e) {
    const message = thrownMessage(e);
    toast.error(message);
    return { status: "error", error: message } as const;
  }
}

export async function generateRecap(
  repoId: string,
  period: RecapPeriod,
  pinned?: { periodStart?: string; periodEnd?: string },
): Promise<{ recapId: string } | null> {
  try {
    const body: { period: RecapPeriod; periodStart?: string; periodEnd?: string } = {
      period,
    };
    if (pinned?.periodStart !== undefined) body.periodStart = pinned.periodStart;
    if (pinned?.periodEnd !== undefined) body.periodEnd = pinned.periodEnd;
    const data = await call(
      api.api.repos({ id: repoId }).recaps.generate.post(body),
      "Failed to start recap",
    );
    // Refresh the list so the new placeholder row appears.
    void fetchRecapsForRepo(repoId);
    return data;
  } catch (e) {
    toast.error(thrownMessage(e));
    return null;
  }
}

export async function regenerateRecap(recapId: string): Promise<{ recapId: string } | null> {
  if (pendingActions.map.has(recapId)) return null;
  setPending(recapId, "regenerate");
  try {
    return await call(
      api.api.recaps({ id: recapId }).regenerate.post(),
      "Failed to regenerate recap",
    );
  } catch (e) {
    toast.error(thrownMessage(e));
    return null;
  } finally {
    clearPending(recapId);
  }
}

export async function stopRecap(recapId: string): Promise<boolean> {
  if (pendingActions.map.has(recapId)) return false;
  setPending(recapId, "stop");
  try {
    abortRecapStream(recapId);
    await call(api.api.recaps({ id: recapId }).stop.post(), "Failed to stop recap");
    // The server broadcasts the stop too; the UI doesn't wait for it.
    patchRecapStatus(recapId, null, { status: "stopped", errorMessage: null, completedAt: null });
    return true;
  } catch (e) {
    toast.error(thrownMessage(e));
    return false;
  } finally {
    clearPending(recapId);
  }
}

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

function patchRecapStatus(recapId: string, repoId: string | null, patch: StatusPatch): void {
  const owner =
    repoId ??
    recapDetailById.get(recapId)?.repositoryId ??
    [...recapsByRepo].find(([, list]) => list.some((r) => r.id === recapId))?.[0] ??
    null;
  if (owner !== null) {
    recapsByRepo = updateEntry(recapsByRepo, owner, (current = []) =>
      mergeSummaries(
        current,
        current.filter((row) => row.id === recapId).map((row) => ({ ...row, ...patch })),
      ),
    );
  }
  const existing = recapDetailById.get(recapId);
  if (existing) recapDetailById = setEntry(recapDetailById, recapId, { ...existing, ...patch });
}

/** `recap:added` carries the full row, both for new rows and on completion. */
export function onRecapAdded(data: { recap: ProjectRecap }): void {
  const recap = data.recap;
  recapDetailById = setEntry(recapDetailById, recap.id, recap);

  const list = recapsByRepo.get(recap.repositoryId);
  if (!list) return;
  recapsByRepo = setEntry(
    recapsByRepo,
    recap.repositoryId,
    mergeSummaries(list, [recapSummaryOf(recap)]),
  );
}

/** `recap:*` events sent while the stream was down reached no one: re-read what's loaded. */
export function onEventsReconnected(): void {
  repoReads.refreshAll();
  monthReads.refreshAll();
  detailReads.refreshAll();
}

export function reset(): void {
  recapsByRepo = new Map();
  recapDetailById = new Map();
  repoReads.reset();
  monthReads.reset();
  detailReads.reset();
  pendingActions.map = new Map();
}

/**
 * A repo's recap summaries, asked for when the calling component mounts or
 * its repo changes; the recap SSE handlers keep them fresh after that. Call
 * during component init.
 */
export function useRecapsForRepo(getRepoId: () => string): {
  readonly list: ProjectRecapSummary[];
  readonly loading: boolean;
} {
  $effect(() => {
    const repoId = getRepoId();
    if (repoId) untrack(() => void fetchRecapsForRepo(repoId));
  });
  return {
    get list() {
      return getRecapsForRepo(getRepoId());
    },
    get loading() {
      return getRecapLoading(getRepoId());
    },
  };
}
