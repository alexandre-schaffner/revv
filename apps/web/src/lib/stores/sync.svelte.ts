import type { ThreadSummary } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";

// Map keyed by PR id (`owner/repo:number`) — summary is recomputed server-side
// on every sync tick and broadcast via `threads:synced`.
let summaries = $state<Map<string, ThreadSummary>>(new Map());

// Per-PR last-successful-thread-sync timestamps (ISO). The bottom bar's
// "Synced Xm ago" reflects the currently selected PR's entry, not a global.
let lastSyncAtByPr = $state<Map<string, string>>(new Map());

// Per-PR in-flight threads sync (set after the user clicks sync, cleared on
// `threads:synced`).
let threadsSyncingByPr = $state<Set<string>>(new Set());

// Per-PR last error message. Reserved for request-level sync failures.
let syncErrorByPr = $state<Map<string, string>>(new Map());

// Separate flag for the global PR-list metadata poll (`prs:sync-started` →
// `prs:sync-complete`). The sidebar spinner uses this; it is NOT tied to a
// specific PR and does not affect the bottom bar's per-PR label.
let prListSyncing = $state(false);

export function getLastSyncAt(prId: string | null): string | null {
  if (!prId) return null;
  return lastSyncAtByPr.get(prId) ?? null;
}

export function getThreadsSyncing(prId: string | null): boolean {
  if (!prId) return false;
  return threadsSyncingByPr.has(prId);
}

export function getSyncError(prId: string | null): string | null {
  if (!prId) return null;
  return syncErrorByPr.get(prId) ?? null;
}

export function getPrListSyncing(): boolean {
  return prListSyncing;
}

export function setPrListSyncing(v: boolean): void {
  prListSyncing = v;
}

export function requestSync(): void {
  setPrListSyncing(true);
  void api.api.prs.sync.post().catch(() => {
    setPrListSyncing(false);
    toast.error("Failed to sync pull requests");
  });
}

export function requestThreadSync(prId: string): void {
  markThreadsSyncing(prId);
  void api.api
    .prs({ id: prId })
    ["sync-threads"].post()
    .catch(() => {
      setSyncError(prId, "Failed to reach server");
    });
}

/**
 * Refresh everything about ONE pull request: its GitHub metadata and its
 * comment threads.
 *
 * Deliberately not the global `/prs/sync` — that walks every repo on every
 * account (plus, on a cold cycle, the hourly metadata refresh and archive
 * backfill) to answer a question about a single PR. `/prs/:id/refresh` is a
 * couple of requests, and it reads GitHub's PR detail endpoint, so it also
 * fills in the diff stats the list-endpoint poll can't see.
 */
export function requestFullSync(prId: string): void {
  markThreadsSyncing(prId);
  setPrListSyncing(true);
  void api.api
    .prs({ id: prId })
    .refresh.post()
    .catch(() => {
      toast.error("Failed to refresh pull request");
    })
    .finally(() => {
      // This request is awaited server-side, so its completion IS the signal —
      // there's no `prs:sync-complete` coming to release the spinner.
      setPrListSyncing(false);
    });
  void api.api
    .prs({ id: prId })
    ["sync-threads"].post()
    .catch(() => {
      setSyncError(prId, "Failed to reach server");
    });
}

// Per-PR debounce for `refreshPrHead`. The call reaches GitHub, so a rapid
// alt-tab / dropdown-reopen must not turn into a request per event. 30 s is
// well under the 5-minute poll interval it is compensating for, and the
// underlying PR-detail read is ETag-conditional — an unchanged PR answers 304,
// which GitHub does not charge against the primary REST limit.
const HEAD_REFRESH_DEBOUNCE_MS = 30_000;
const lastHeadRefreshAt = new Map<string, number>();

/**
 * Reconcile ONE pull request's GitHub metadata — head SHA above all — without
 * any visible sync UI.
 *
 * The "new commits, click Pull" affordance compares `pr.headSha` (SQLite,
 * advanced only by the 5-minute poll fiber) against the SHA the on-screen diff
 * was loaded at. Nothing else moves `pr.headSha`: the SSE reconcile paths are
 * DB-only reads by design, so after someone pushes outside Revv the app can sit
 * for a full poll interval knowing nothing — no Pull button, even though the
 * bottom-bar commits dropdown (which reads GitHub live) is already showing the
 * newer commits. This closes that window for the PR the user is actually
 * looking at.
 *
 * Fire-and-forget: `POST /prs/:id/refresh` broadcasts `prs:updated` on success,
 * which is what updates the store. Failure is silent — this is a background
 * freshness check, not something the user asked for, and the manual "Sync now"
 * button is still there to report errors.
 */
export function refreshPrHead(prId: string): void {
  const now = Date.now();
  const last = lastHeadRefreshAt.get(prId);
  if (last !== undefined && now - last < HEAD_REFRESH_DEBOUNCE_MS) return;
  // Drop stamps that can no longer suppress anything. The desktop window is
  // never reloaded, so without this the map keeps one entry per PR ever
  // visited, for the life of the process.
  for (const [id, at] of lastHeadRefreshAt) {
    if (now - at >= HEAD_REFRESH_DEBOUNCE_MS) lastHeadRefreshAt.delete(id);
  }
  lastHeadRefreshAt.set(prId, now);
  void api.api
    .prs({ id: prId })
    .refresh.post()
    .catch(() => {
      // Allow an immediate retry on the next trigger rather than holding the
      // debounce open for a request that never landed.
      lastHeadRefreshAt.delete(prId);
    });
}

// Client-side throttle for `freshenPrList`, matching the server's: it skips a
// freshen when any sync cycle started in the last 2 minutes, so asking more
// often only spends requests. Every window focus calls this, so without it a
// burst of alt-tabs is a burst of POSTs.
const FRESHEN_MIN_INTERVAL_MS = 2 * 60 * 1000;
let lastFreshenAt = 0;

/**
 * Ask the server to check GitHub for PR-list changes, because the user is
 * looking at the list right now.
 *
 * The list on screen is painted from SQLite, which only the server's poll
 * fiber advances — so on launch, or on coming back to the window, it can be a
 * full poll interval behind GitHub. This closes that gap for the whole list
 * the way {@link refreshPrHead} does for one PR: the server runs a sync cycle,
 * and if anything moved, the `prs:updated` it broadcasts updates the store in
 * place. Nothing changes on screen otherwise.
 *
 * Fire-and-forget, and must only run with the SSE stream open: the result
 * arrives as an event, and an event sent before this client's stream is
 * registered is lost.
 */
export function freshenPrList(): void {
  const now = Date.now();
  if (now - lastFreshenAt < FRESHEN_MIN_INTERVAL_MS) return;
  lastFreshenAt = now;
  // A failure isn't retried early: the periodic poll still runs, and retrying
  // on every focus is exactly the spam the throttle exists to stop.
  void api.api.prs.freshen.post().catch(() => undefined);
}

/** Mark a PR's threads sync as in-flight (called when we send the request). */
export function markThreadsSyncing(prId: string): void {
  const next = new Set(threadsSyncingByPr);
  next.add(prId);
  threadsSyncingByPr = next;
  // Clear any stale error from a previous attempt so the UI doesn't flash
  // "Sync failed" next to a spinner.
  if (syncErrorByPr.has(prId)) {
    const nextErr = new Map(syncErrorByPr);
    nextErr.delete(prId);
    syncErrorByPr = nextErr;
  }
}

export function setSyncError(prId: string, message: string): void {
  if (threadsSyncingByPr.has(prId)) {
    const nextSyncing = new Set(threadsSyncingByPr);
    nextSyncing.delete(prId);
    threadsSyncingByPr = nextSyncing;
  }
  const nextErr = new Map(syncErrorByPr);
  nextErr.set(prId, message);
  syncErrorByPr = nextErr;
}

export function applySynced(prId: string, summary: ThreadSummary, timestamp: string): void {
  const nextSummaries = new Map(summaries);
  nextSummaries.set(prId, summary);
  summaries = nextSummaries;

  const nextTs = new Map(lastSyncAtByPr);
  nextTs.set(prId, timestamp);
  lastSyncAtByPr = nextTs;

  if (threadsSyncingByPr.has(prId)) {
    const nextSyncing = new Set(threadsSyncingByPr);
    nextSyncing.delete(prId);
    threadsSyncingByPr = nextSyncing;
  }

  if (syncErrorByPr.has(prId)) {
    const nextErr = new Map(syncErrorByPr);
    nextErr.delete(prId);
    syncErrorByPr = nextErr;
  }
}

export function setBatchSummaries(entries: Array<{ prId: string; summary: ThreadSummary }>): void {
  const next = new Map(summaries);
  for (const { prId, summary } of entries) next.set(prId, summary);
  summaries = next;
}
