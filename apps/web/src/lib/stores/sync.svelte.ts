import type { ThreadSummary } from '@revv/shared';

// Map keyed by PR id (`owner/repo:number`) — summary is recomputed server-side
// on every sync tick and broadcast via `threads:synced`.
let summaries = $state<Map<string, ThreadSummary>>(new Map());

// Per-PR last-successful-thread-sync timestamps (ISO). The bottom bar's
// "Synced Xm ago" reflects the currently selected PR's entry, not a global.
let lastSyncAtByPr = $state<Map<string, string>>(new Map());

// Per-PR in-flight threads sync (set after the user clicks sync / we queue a
// request, cleared on `threads:synced` or `threads:sync-error`).
let threadsSyncingByPr = $state<Set<string>>(new Set());

// Per-PR last error message from `threads:sync-error`.
let syncErrorByPr = $state<Map<string, string>>(new Map());

// Separate flag for the global PR-list metadata poll (`prs:sync-started` →
// `prs:sync-complete`). The sidebar spinner uses this; it is NOT tied to a
// specific PR and does not affect the bottom bar's per-PR label.
let prListSyncing = $state(false);

export function getSummary(prId: string): ThreadSummary | null {
	return summaries.get(prId) ?? null;
}

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

export function applySyncError(prId: string, message: string): void {
	const nextErr = new Map(syncErrorByPr);
	nextErr.set(prId, message);
	syncErrorByPr = nextErr;

	if (threadsSyncingByPr.has(prId)) {
		const nextSyncing = new Set(threadsSyncingByPr);
		nextSyncing.delete(prId);
		threadsSyncingByPr = nextSyncing;
	}
}

export function setBatchSummaries(entries: Array<{ prId: string; summary: ThreadSummary }>): void {
	const next = new Map(summaries);
	for (const { prId, summary } of entries) next.set(prId, summary);
	summaries = next;
}

export function reset(): void {
	summaries = new Map();
	lastSyncAtByPr = new Map();
	threadsSyncingByPr = new Set();
	syncErrorByPr = new Map();
	prListSyncing = false;
}
