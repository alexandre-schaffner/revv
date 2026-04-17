import type { ThreadSummary } from '@revv/shared';

// Map keyed by PR id (`owner/repo:number`) — summary is recomputed server-side
// on every sync tick and broadcast via `threads:synced`.
let summaries = $state<Map<string, ThreadSummary>>(new Map());

// Last successful thread-sync timestamp (ISO string) for any PR.
let lastSyncAt = $state<string | null>(null);
// Whether a manual sync is in-flight right now.
let syncing = $state(false);
let syncError = $state<string | null>(null);

export function getSummary(prId: string): ThreadSummary | null {
	return summaries.get(prId) ?? null;
}

export function getLastSyncAt(): string | null {
	return lastSyncAt;
}

export function getSyncing(): boolean {
	return syncing;
}

export function getSyncError(): string | null {
	return syncError;
}

export function setSyncing(v: boolean): void {
	syncing = v;
}

export function setSyncError(err: string | null): void {
	syncError = err;
}

export function applySynced(prId: string, summary: ThreadSummary, timestamp: string): void {
	const next = new Map(summaries);
	next.set(prId, summary);
	summaries = next;
	lastSyncAt = timestamp;
	syncError = null;
}

export function setBatchSummaries(entries: Array<{ prId: string; summary: ThreadSummary }>): void {
	const next = new Map(summaries);
	for (const { prId, summary } of entries) next.set(prId, summary);
	summaries = next;
}

export function reset(): void {
	summaries = new Map();
	lastSyncAt = null;
	syncing = false;
	syncError = null;
}
