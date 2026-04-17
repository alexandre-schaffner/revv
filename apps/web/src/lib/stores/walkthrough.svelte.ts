import type { WalkthroughBlock, RiskLevel, WalkthroughStreamEvent, WalkthroughIssue, WalkthroughPhase } from '@revv/shared';
import { API_BASE_URL } from '@revv/shared';
import { authHeaders } from '$lib/utils/session-token';
import { parseSSEBuffer } from '$lib/utils/sse-parser';
import { toast } from 'svelte-sonner';

// ── Per-PR state entry ──────────────────────────────────────────────────────

interface WalkthroughEntry {
	blocks: WalkthroughBlock[];
	summary: string | null;
	riskLevel: RiskLevel;
	isStreaming: boolean;
	streamError: string | null;
	walkthroughId: string | null;
	doneReceived: boolean;
	explorationSteps: Array<{ tool: string; description: string }>;
	issues: WalkthroughIssue[];
	phase: WalkthroughPhase;
	phaseMessage: string;
	streamStartedAt: number | null;
	/**
	 * True once we've observed the server advance past the `connecting` phase —
	 * which only happens during a live generation. Cached replays stream
	 * summary → blocks → issues → done without emitting phase events, so this
	 * stays false. The UI uses it to hide the progress stepper on cache hits.
	 */
	liveGeneration: boolean;
}

function freshEntry(): WalkthroughEntry {
	return {
		blocks: [],
		summary: null,
		riskLevel: 'low',
		isStreaming: true,
		streamError: null,
		walkthroughId: null,
		doneReceived: false,
		explorationSteps: [],
		issues: [],
		phase: 'connecting',
		phaseMessage: 'Connecting...',
		streamStartedAt: Date.now(),
		liveGeneration: false,
	};
}

// ── Reactive state ──────────────────────────────────────────────────────────

let entries = $state(new Map<string, WalkthroughEntry>());
let activePrId = $state<string | null>(null);

// Non-reactive — abort controllers keyed by PR ID.
// Map iteration order = insertion order, so iterating gives oldest-first.
const controllers = new Map<string, { abort: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> | null }>();

// Cap on concurrent walkthrough SSE streams. WebKit caps HTTP/1.1 at ~6
// connections per host; each SSE stream holds one indefinitely. Without a
// cap, clicking through enough PRs exhausts the pool and short-lived
// fetches (e.g. /api/prs/:id/files) queue forever — manifesting as the
// review page sitting on "Loading diff…". Server keeps generating after
// we disconnect and caches the result, so aborting is non-destructive.
const MAX_CONCURRENT_STREAMS = 3;

// ── Getters (resolve from active PR entry) ──────────────────────────────────

function active(): WalkthroughEntry | undefined {
	if (!activePrId) return undefined;
	return entries.get(activePrId);
}

export function getBlocks(): WalkthroughBlock[] {
	return active()?.blocks ?? [];
}
export function getSummary(): string | null {
	return active()?.summary ?? null;
}
export function getRiskLevel(): RiskLevel {
	return active()?.riskLevel ?? 'low';
}
export function getIsStreaming(): boolean {
	return active()?.isStreaming ?? false;
}
export function getStreamError(): string | null {
	return active()?.streamError ?? null;
}
export function getWalkthroughId(): string | null {
	return active()?.walkthroughId ?? null;
}
export function getExplorationSteps(): Array<{ tool: string; description: string }> {
	return active()?.explorationSteps ?? [];
}
export function getIssues(): WalkthroughIssue[] {
	return active()?.issues ?? [];
}
export function getPhase(): WalkthroughPhase {
	return active()?.phase ?? 'connecting';
}
export function getPhaseMessage(): string {
	return active()?.phaseMessage ?? 'Connecting...';
}
export function getStreamStartedAt(): number | null {
	return active()?.streamStartedAt ?? null;
}
export function getIsLiveGeneration(): boolean {
	return active()?.liveGeneration ?? false;
}

// ── Status query (for sidebar / external consumers) ─────────────────────────

export function getPrWalkthroughStatus(prId: string): 'idle' | 'generating' | 'complete' | 'error' {
	const entry = entries.get(prId);
	if (!entry) return 'idle';
	if (entry.isStreaming) return 'generating';
	if (entry.streamError) return 'error';
	if (entry.summary) return 'complete';
	return 'idle';
}

// ── Helpers to mutate an entry in the Map ───────────────────────────────────

function getOrCreateEntry(prId: string): WalkthroughEntry {
	let entry = entries.get(prId);
	if (!entry) {
		entry = freshEntry();
		entries.set(prId, entry);
		// Trigger reactivity by reassigning the Map
		entries = new Map(entries);
	}
	return entry;
}

function updateEntry(prId: string, updater: (e: WalkthroughEntry) => void): void {
	const entry = entries.get(prId);
	if (!entry) return;
	updater(entry);
	// Trigger reactivity by reassigning the Map
	entries = new Map(entries);
}

// ── Core streaming ──────────────────────────────────────────────────────────

export async function streamWalkthrough(prId: string): Promise<void> {
	// Switch the active view
	activePrId = prId;

	const existing = entries.get(prId);

	// Already streaming this PR — just switch the view
	if (existing?.isStreaming) return;

	// Already have completed data for this PR — just show it
	if (existing && existing.summary !== null && existing.blocks.length > 0 && !existing.streamError) return;

	// Abort any existing SSE for this specific PR (e.g. errored state, regenerate)
	abortPr(prId);

	// Free a connection slot if we're at the cap. Must run after abortPr
	// (so this PR isn't already in controllers) and before controllers.set.
	enforceStreamCap();

	// Create fresh entry
	const entry = freshEntry();
	entries.set(prId, entry);
	entries = new Map(entries);

	const abortCtrl = new AbortController();
	controllers.set(prId, { abort: abortCtrl, reader: null });

	try {
		const res = await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough`, {
			headers: authHeaders(),
			signal: abortCtrl.signal,
		});
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => '');
			let message = `HTTP ${res.status}`;
			try {
				const body = JSON.parse(text);
				message = body.message ?? body.error ?? message;
			} catch { /* use default */ }
			throw new Error(message);
		}

		const reader = res.body.getReader();
		const ctrl = controllers.get(prId);
		if (ctrl) ctrl.reader = reader;
		const decoder = new TextDecoder();
		let buffer = '';

		const INACTIVITY_TIMEOUT_MS = 90 * 1000;
		let lastEventTime = Date.now();

		const EXPLORATION_STALL_MS = 3 * 60 * 1000;
		let lastProgressEventTime = Date.now();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			const result = parseSSEBuffer<WalkthroughStreamEvent>(buffer);
			buffer = result.remaining;

			if (result.events.length > 0) {
				lastEventTime = Date.now();

				const hasProgress = result.events.some(e => e.type !== 'exploration');
				if (hasProgress) {
					lastProgressEventTime = Date.now();
				} else if (Date.now() - lastProgressEventTime > EXPLORATION_STALL_MS) {
					throw new Error('Walkthrough stalled — the model explored files for 3 minutes without producing output. Try regenerating.');
				}

				applyEvents(prId, result.events);
			} else if (Date.now() - lastEventTime > INACTIVITY_TIMEOUT_MS) {
				throw new Error('Walkthrough generation appears stuck — no progress for 3 minutes. Try regenerating.');
			}

			if (result.done) break;
		}

		if (buffer.trim()) {
			const result = parseSSEBuffer<WalkthroughStreamEvent>(buffer + '\n\n');
			if (result.events.length > 0) {
				applyEvents(prId, result.events);
			}
		}
	} catch (e) {
		if ((e as Error).name !== 'AbortError') {
			updateEntry(prId, (en) => {
				en.streamError = e instanceof Error ? e.message : 'Stream failed';
			});
			toast.error(e instanceof Error ? e.message : 'Walkthrough failed');
		}
	} finally {
		const en = entries.get(prId);
		// If the stream ended but we never received a terminal event (done/error/in-progress),
		// and the entry is still marked as streaming, check what happened.
		if (en?.isStreaming && !en.doneReceived && !en.streamError) {
			// The SSE connection closed — but the server may still be generating.
			// Don't show an error; the entry stays in a "generating" state and
			// the WS walkthrough:complete / walkthrough:error will update it.
			// However, if we have no data at all, the user probably never triggered
			// a generation — show an error.
			if (!en.summary) {
				updateEntry(prId, (e) => {
					e.streamError = 'Walkthrough generation ended unexpectedly. Try regenerating.';
					e.isStreaming = false;
				});
			}
			// If we have partial data (summary exists), keep isStreaming true —
			// the server is still generating in the background.
		}
		controllers.delete(prId);
	}
}

function applyEvents(prId: string, events: WalkthroughStreamEvent[]): void {
	updateEntry(prId, (entry) => {
		let newBlocks: WalkthroughBlock[] | null = null;

		for (const event of events) {
			switch (event.type) {
				case 'summary':
					entry.summary = event.data.summary;
					entry.riskLevel = event.data.riskLevel;
					break;
				case 'block':
					if (!newBlocks) newBlocks = [...entry.blocks];
					newBlocks.push(event.data);
					break;
				case 'done':
					entry.walkthroughId = event.data.walkthroughId;
					entry.doneReceived = true;
					entry.isStreaming = false;
					break;
				case 'exploration':
					entry.explorationSteps = [...entry.explorationSteps, event.data];
					break;
				case 'issue':
					if (!entry.issues.some((i) => i.id === event.data.id)) {
						entry.issues = [...entry.issues, event.data];
					}
					break;
				case 'phase':
					entry.phase = event.data.phase;
					entry.phaseMessage = event.data.message;
					if (event.data.phase !== 'connecting') {
						entry.liveGeneration = true;
					}
					break;
				case 'error':
					entry.streamError = event.data.message;
					entry.isStreaming = false;
					break;
				case 'in-progress':
					// Server says generation is running in the background.
					// Keep isStreaming true — WS will notify on completion.
					entry.walkthroughId = event.data.walkthroughId;
					entry.phase = 'writing';
					entry.phaseMessage = 'Generating in background...';
					entry.liveGeneration = true;
					break;
			}
		}

		if (newBlocks) {
			entry.blocks = newBlocks;
		}
	});
}

// ── Abort / reset ───────────────────────────────────────────────────────────

function abortPr(prId: string): void {
	const ctrl = controllers.get(prId);
	if (ctrl) {
		ctrl.reader?.cancel().catch(() => {});
		ctrl.reader = null;
		ctrl.abort.abort();
		controllers.delete(prId);
	}
}

/**
 * Abort oldest non-active streams until there's room for a new one.
 * Reset aborted entries so a later visit triggers a fresh fetch — the
 * server's partial cache means the user doesn't lose progress.
 */
function enforceStreamCap(): void {
	let mutated = false;
	while (controllers.size >= MAX_CONCURRENT_STREAMS) {
		let victim: string | null = null;
		for (const prId of controllers.keys()) {
			if (prId === activePrId) continue;
			victim = prId;
			break;
		}
		if (victim === null) break; // only activePrId left — nothing to drop
		abortPr(victim);
		const entry = entries.get(victim);
		if (entry) {
			entry.isStreaming = false;
			entry.summary = null;
			entry.blocks = [];
			entry.issues = [];
			entry.explorationSteps = [];
			entry.doneReceived = false;
			mutated = true;
		}
	}
	if (mutated) entries = new Map(entries);
}

export function abort(): void {
	if (activePrId) {
		abortPr(activePrId);
		updateEntry(activePrId, (e) => {
			e.isStreaming = false;
		});
	}
}

export async function regenerate(prId: string): Promise<void> {
	// Abort and remove existing entry for this PR
	abortPr(prId);
	entries.delete(prId);
	entries = new Map(entries);

	activePrId = prId;

	// Create a temporary "regenerating" entry so the UI shows loading state
	const entry = freshEntry();
	entry.phaseMessage = 'Regenerating...';
	entries.set(prId, entry);
	entries = new Map(entries);

	// Await cache invalidation so the subsequent stream request doesn't
	// race and find the old errored walkthrough still in the database.
	try {
		await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/regenerate`, {
			method: 'POST',
			headers: authHeaders(),
		});
	} catch {
		// If invalidation fails, streamWalkthrough will still attempt a
		// fresh generation — worst case the server resumes the partial.
	}

	// Remove the temp entry so streamWalkthrough creates a clean one
	entries.delete(prId);
	entries = new Map(entries);

	await streamWalkthrough(prId);
}

/** Clear active PR without aborting any background streams. */
export function deactivate(): void {
	activePrId = null;
}

export function reset(): void {
	if (activePrId) {
		abortPr(activePrId);
		entries.delete(activePrId);
		entries = new Map(entries);
		activePrId = null;
	}
}

// ── WS-driven updates (called from ws.svelte.ts) ───────────────────────────

export function onWalkthroughComplete(prId: string, walkthroughId: string): void {
	const entry = entries.get(prId);
	if (entry) {
		updateEntry(prId, (e) => {
			e.isStreaming = false;
			e.doneReceived = true;
			e.walkthroughId = walkthroughId;
		});
		// If this is the active PR and we don't have blocks yet (SSE was disconnected
		// before data arrived), fetch the full walkthrough from the server.
		if (activePrId === prId && entry.blocks.length === 0) {
			fetchCachedWalkthrough(prId);
		}
	} else {
		// No entry — the user hasn't viewed this PR yet. Create a stub so the
		// sidebar can show "complete" status, and we'll load data when they navigate.
		const stub = freshEntry();
		stub.isStreaming = false;
		stub.doneReceived = true;
		stub.walkthroughId = walkthroughId;
		entries.set(prId, stub);
		entries = new Map(entries);
	}
}

export function onWalkthroughError(prId: string, message: string): void {
	const entry = entries.get(prId);
	if (entry) {
		updateEntry(prId, (e) => {
			e.isStreaming = false;
			e.streamError = message;
		});
	}
}

async function fetchCachedWalkthrough(prId: string): Promise<void> {
	// Use the SSE endpoint — server will replay from cache instantly
	activePrId = prId;
	// Remove existing entry so streamWalkthrough creates a clean one
	abortPr(prId);
	entries.delete(prId);
	entries = new Map(entries);
	await streamWalkthrough(prId);
}
