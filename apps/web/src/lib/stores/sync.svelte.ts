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
