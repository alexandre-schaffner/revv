import type { WalkthroughBlock, RiskLevel, WalkthroughStreamEvent, WalkthroughIssue, WalkthroughPhase, WalkthroughRating, CarriedOverIssue, CloneStatus } from '@revv/shared';
import { API_BASE_URL } from '@revv/shared';
import { authHeaders } from '$lib/utils/session-token';
import { runWalkthroughSse } from '$lib/services/walkthrough-sse';
import { api } from '$lib/api/client';
import { updateRepoCloneStatus } from '$lib/stores/prs.svelte';
import { toast } from 'svelte-sonner';

// ── Per-PR state entry ──────────────────────────────────────────────────────

interface WalkthroughEntry {
	blocks: WalkthroughBlock[];
	summary: string | null;
	riskLevel: RiskLevel | null;
	isStreaming: boolean;
	streamError: string | null;
	walkthroughId: string | null;
	doneReceived: boolean;
	explorationSteps: Array<{ tool: string; description: string }>;
	issues: WalkthroughIssue[];
	ratings: WalkthroughRating[];
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
	/** True when the server rejected the walkthrough because the repo is mid-clone. */
	cloneInProgress: boolean;
	/** The repo ID that is being cloned, when cloneInProgress is true. */
	cloneRepoId: string | null;
}

function freshEntry(): WalkthroughEntry {
	return {
		blocks: [],
		summary: null,
		riskLevel: null,
		isStreaming: true,
		streamError: null,
		walkthroughId: null,
		doneReceived: false,
		explorationSteps: [],
		issues: [],
		ratings: [],
		phase: 'connecting',
		phaseMessage: 'Connecting...',
		streamStartedAt: Date.now(),
		liveGeneration: false,
		cloneInProgress: false,
		cloneRepoId: null,
	};
}

// ── Reactive state ──────────────────────────────────────────────────────────

let entries = $state(new Map<string, WalkthroughEntry>());
let activePrId = $state<string | null>(null);

// Non-reactive — abort controllers keyed by PR ID.
// Map iteration order = insertion order, so iterating gives oldest-first.
const controllers = new Map<string, { abort: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> | null }>();

// Non-reactive — clone-status pollers keyed by PR ID. One active poller per PR
// at a time; the `cancelled` flag lets either the component's effect cleanup
// or the next poll-start call stop the loop cooperatively between ticks.
const clonePollers = new Map<string, { cancelled: boolean }>();

// Cap on concurrent walkthrough SSE streams. WebKit caps HTTP/1.1 at ~6
// connections per host; each SSE stream holds one indefinitely. Without a
// cap, clicking through enough PRs exhausts the pool and short-lived
// fetches (e.g. /api/prs/:id/files) queue forever — manifesting as the
// review page sitting on "Loading diff…". Server keeps generating after
// we disconnect and caches the result, so aborting is non-destructive.
const MAX_CONCURRENT_STREAMS = 5;

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
export function getRiskLevel(): RiskLevel | null {
	return active()?.riskLevel ?? null;
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
export function getIssuesForFile(filePath: string): WalkthroughIssue[] {
	const issues = active()?.issues ?? [];
	return issues.filter((i) => i.filePath === filePath);
}
export function getRatings(): WalkthroughRating[] {
	return active()?.ratings ?? [];
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
export function getCloneInProgress(): boolean {
	return active()?.cloneInProgress ?? false;
}
export function getCloneRepoId(): string | null {
	return active()?.cloneRepoId ?? null;
}

// ── Clone-status polling (self-healing un-stick) ────────────────────────────
//
// The walkthrough SSE returns a terminal `CloneInProgress` error when the
// server sees the repo is still cloning. To un-stick, we rely on a WS-driven
// $effect in GuidedWalkthrough that watches repositories[repoId].cloneStatus.
// That's brittle: the server only broadcasts `repos:clone-status` on
// 'ready'/'error', so any missed/out-of-order WS delivery — or a server
// restart mid-clone that resets status to 'pending' — leaves the UI stuck
// forever with no escape hatch.
//
// Polling the existing `GET /api/repos/:id/clone-status` endpoint closes
// that gap deterministically. It runs only while the entry is in a
// clone-in-progress state, coalesces concurrent starts, cancels on
// $effect cleanup, and surfaces an actionable error on terminal
// 'error'/'pending' states instead of hanging.

const CLONE_POLL_INTERVAL_MS = 2000;
const CLONE_POLL_MAX_MS = 10 * 60 * 1000;

export function stopClonePoll(prId: string): void {
	const p = clonePollers.get(prId);
	if (p) p.cancelled = true;
	clonePollers.delete(prId);
}

export async function pollCloneUntilResolved(prId: string, repoId: string): Promise<void> {
	// Coalesce: if an in-flight poll is already running for this PR, do
	// nothing. $effect re-runs with the same deps would otherwise spawn
	// duplicate loops.
	if (clonePollers.has(prId)) return;
	const token = { cancelled: false };
	clonePollers.set(prId, token);
	const startedAt = Date.now();
	try {
		while (!token.cancelled) {
			// Bail if the entry is no longer in the clone-in-progress state the
			// poller was started for — could mean: user regenerated, WS already
			// flipped to 'ready' and triggered the fast-path retry, navigated
			// away, or the store reset for some other reason.
			const entry = entries.get(prId);
			if (!entry || !entry.cloneInProgress || entry.cloneRepoId !== repoId) return;

			let status: CloneStatus = 'cloning';
			let error: string | null = null;
			try {
				const { data } = await api.api.repos({ id: repoId })['clone-status'].get();
				// The endpoint's response is a union of { status, path, error }
				// (success) and { error } (handleAppError fallback). Narrow on
				// `status in data` so the error-only shape doesn't misread as a
				// successful status lookup.
				if (data && 'status' in data) {
					status = data.status;
					error = data.error ?? null;
				}
			} catch {
				// Transient network blip — keep polling until the overall timeout.
			}

			if (token.cancelled) return;

			// Mirror to the prs store so Settings + the fast-path $effect stay
			// consistent even if we never received the WS message.
			updateRepoCloneStatus(repoId, status, error ?? undefined);

			if (status === 'ready') {
				// streamWalkthrough clears cloneInProgress / cloneRepoId at its top,
				// which will make the next loop iteration exit if somehow we re-enter.
				void streamWalkthrough(prId);
				return;
			}
			if (status === 'error' || status === 'pending') {
				updateEntry(prId, (e) => {
					e.cloneInProgress = false;
					e.cloneRepoId = null;
					e.isStreaming = false;
					e.streamError = status === 'error'
						? `Repository clone failed${error ? `: ${error}` : ''}. Retry to try again.`
						: 'Repository clone was reset. Retry to try again.';
				});
				return;
			}

			if (Date.now() - startedAt > CLONE_POLL_MAX_MS) {
				updateEntry(prId, (e) => {
					e.cloneInProgress = false;
					e.cloneRepoId = null;
					e.isStreaming = false;
					e.streamError = 'Repository clone is taking too long. Retry to try again.';
				});
				return;
			}

			await new Promise((r) => setTimeout(r, CLONE_POLL_INTERVAL_MS));
		}
	} finally {
		// Only remove our own token — a concurrent stopClonePoll/restart may
		// have already deleted or replaced the entry.
		if (clonePollers.get(prId) === token) clonePollers.delete(prId);
	}
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

/**
 * Synchronously mark a PR as active and seed a "loading" entry if one
 * doesn't already exist in a usable state. Runs on component mount,
 * before the stream-start debounce fires, so the UI can render the
 * skeleton immediately instead of briefly flashing the "No walkthrough
 * data received" empty state — which would otherwise show whenever the
 * store has no entry yet (first visit) or only holds a bare stub from
 * a `walkthrough:complete` WebSocket event.
 *
 * Does NOT start a fetch — that's streamWalkthrough's job. The two
 * coordinate via the `controllers` Map: a seeded entry has
 * `isStreaming: true` but no controller, so streamWalkthrough knows
 * it's still pending and proceeds with the fetch.
 */
export function prepareEntry(prId: string): void {
	activePrId = prId;
	// Leave in-flight fetches alone — their entry is already correct.
	if (controllers.has(prId)) return;
	const existing = entries.get(prId);
	// Leave entries that already hold complete data alone.
	if (existing && existing.summary !== null && existing.blocks.length > 0 && existing.doneReceived && !existing.streamError) return;
	// Replace stub / errored / missing entries with a fresh loading one so
	// the UI shows the skeleton during the debounce window.
	entries.set(prId, freshEntry());
	entries = new Map(entries);
}

export async function streamWalkthrough(prId: string): Promise<void> {
	// Switch the active view
	activePrId = prId;

	// Any in-flight clone poll for this PR is now redundant — we're kicking
	// off a fresh SSE that will either succeed or produce a new error that
	// updates the entry. Stop the poll so it can't race us.
	stopClonePoll(prId);

	const existing = entries.get(prId);

	// An active fetch for this PR is already in-flight — just switch the
	// view, unless that fetch appears stale (started >10min ago with no
	// completion), in which case fall through and re-fetch.
	//
	// We key the guard off `controllers.has(prId)` (not `entry.isStreaming`)
	// because prepareEntry seeds an entry with `isStreaming: true` before
	// any fetch starts. Checking isStreaming would make streamWalkthrough
	// return early for a just-prepared entry and silently skip the fetch.
	const STALE_STREAM_MS = 10 * 60 * 1000;
	const hasController = controllers.has(prId);
	const isStale =
		hasController &&
		existing?.streamStartedAt != null &&
		!existing.doneReceived &&
		Date.now() - existing.streamStartedAt > STALE_STREAM_MS;
	if (hasController && !isStale) return;

	// Already have completed data for this PR — just show it
	if (existing && existing.summary !== null && existing.blocks.length > 0 && existing.doneReceived && !existing.streamError) return;

	// Abort any existing SSE for this specific PR (e.g. errored state, regenerate)
	abortPr(prId);

	// Free a connection slot if we're at the cap. Must run after abortPr
	// (so this PR isn't already in controllers) and before controllers.set.
	enforceStreamCap();

	// Reuse a prepared-but-untouched entry if one is sitting in the Map —
	// that way prepareEntry's `streamStartedAt` carries over and the elapsed
	// timer doesn't reset to 0 the moment the fetch begins. Anything past a
	// freshly-seeded state (has data, error, exploration activity, etc.) is
	// discarded for a clean slate.
	const reusable = !!existing
		&& !existing.streamError
		&& !existing.cloneInProgress
		&& existing.summary === null
		&& existing.blocks.length === 0
		&& existing.explorationSteps.length === 0
		&& existing.issues.length === 0
		&& existing.ratings.length === 0;
	const entry = reusable && existing ? existing : freshEntry();
	entry.isStreaming = true;
	entry.cloneInProgress = false;
	entry.cloneRepoId = null;
	if (pendingKeptIssues.length > 0) {
		entry.issues = [...pendingKeptIssues];
		pendingKeptIssues = [];
	}
	entries.set(prId, entry);
	entries = new Map(entries);

	const abortCtrl = new AbortController();
	controllers.set(prId, { abort: abortCtrl, reader: null });

	try {
		await runWalkthroughSse({
			url: `${API_BASE_URL}/api/reviews/${prId}/walkthrough`,
			signal: abortCtrl.signal,
			onReaderReady: (reader) => {
				const ctrl = controllers.get(prId);
				if (ctrl) ctrl.reader = reader;
			},
			onEvents: (events) => applyEvents(prId, events),
			explorationStallMessage:
				'Walkthrough stalled — the model explored files for 3 minutes without producing output. Try regenerating.',
			inactivityMessage:
				'Walkthrough generation appears stuck — no progress for 3 minutes. Try regenerating.',
		});
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
		// Only remove our controller — fetchCachedWalkthrough may have already
		// replaced it with a new stream's controller.
		const current = controllers.get(prId);
		if (current?.abort === abortCtrl) {
			controllers.delete(prId);
		}
	}
}

/**
 * Try to hydrate the walkthrough store for a PR from the cached JSON endpoint.
 * Returns true if the cache was hit and the store was populated, false if no
 * cache exists (caller should fall back to SSE streaming).
 *
 * This is intentionally a cheap JSON fetch — not SSE — so it can run
 * immediately on mount without holding an HTTP connection open.
 */
export async function hydrateFromCache(prId: string): Promise<boolean> {
	// Already have complete data — nothing to do
	const existing = entries.get(prId);
	if (
		existing &&
		existing.summary !== null &&
		existing.blocks.length > 0 &&
		existing.doneReceived &&
		!existing.streamError
	) {
		activePrId = prId;
		return true;
	}

	try {
		const res = await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/cached`, {
			headers: authHeaders(),
			credentials: 'include',
		});
		if (!res.ok) return false;

		const body = (await res.json()) as
			| { cached: false }
			| {
					cached: true;
					walkthrough: {
						id: string;
						summary: string;
						riskLevel: RiskLevel;
						blocks: WalkthroughBlock[];
						issues: WalkthroughIssue[];
						ratings: WalkthroughRating[];
						tokenUsage: unknown;
						reviewSessionId: string;
					};
			  };

		if (!body.cached) return false;

		const wt = body.walkthrough;

		// Hydrate the entry directly from JSON — no SSE round-trip needed
		const entry = entries.get(prId) ?? freshEntry();
		entry.summary = wt.summary;
		entry.riskLevel = wt.riskLevel;
		entry.blocks = wt.blocks;
		entry.issues = wt.issues;
		entry.ratings = wt.ratings;
		entry.walkthroughId = wt.id;
		entry.doneReceived = true;
		entry.isStreaming = false;
		entry.streamError = null;
		entry.phase = 'finishing';
		entry.phaseMessage = 'Complete';
		entry.liveGeneration = false;
		entries.set(prId, entry);
		entries = new Map(entries);

		activePrId = prId;
		return true;
	} catch {
		return false;
	}
}

/**
 * Start a background walkthrough generation for a PR without changing
 * the active (visible) PR. Used to pre-generate walkthroughs for PRs
 * that just appeared in the "Needs Your Review" list.
 */
export async function prefetchWalkthrough(prId: string): Promise<void> {
	const existing = entries.get(prId);

	// Already streaming or already has complete data — nothing to do
	if (existing?.isStreaming) return;
	if (existing && existing.summary !== null && existing.blocks.length > 0 && !existing.streamError) return;

	// Abort any existing (errored) entry for this PR
	abortPr(prId);

	// Reserve our slot before enforcing the cap so concurrent prefetches
	// are counted correctly and the cap is never exceeded.
	const abortCtrl = new AbortController();
	controllers.set(prId, { abort: abortCtrl, reader: null });

	// Enforce the cap — may evict this PR if it's not active
	enforceStreamCap();

	// If we were evicted by enforceStreamCap, bail out
	if (!controllers.has(prId)) return;

	// Create fresh entry
	const entry = freshEntry();
	entries.set(prId, entry);
	entries = new Map(entries);

	try {
		await runWalkthroughSse({
			url: `${API_BASE_URL}/api/reviews/${prId}/walkthrough`,
			signal: abortCtrl.signal,
			onReaderReady: (reader) => {
				const ctrl = controllers.get(prId);
				if (ctrl) ctrl.reader = reader;
			},
			onEvents: (events) => applyEvents(prId, events),
			explorationStallMessage: 'Walkthrough stalled during prefetch.',
			inactivityMessage: 'Walkthrough prefetch appears stuck.',
		});
	} catch (e) {
		if ((e as Error).name !== 'AbortError') {
			updateEntry(prId, (en) => {
				en.streamError = e instanceof Error ? e.message : 'Prefetch failed';
				en.isStreaming = false;
			});
		}
	} finally {
		const en = entries.get(prId);
		if (en?.isStreaming && !en.doneReceived && !en.streamError) {
			// SSE closed while server still generating in background — keep
			// isStreaming true; WS walkthrough:complete will update it.
			if (!en.summary) {
				updateEntry(prId, (e) => {
					e.isStreaming = false;
					// Don't set streamError — user hasn't seen this PR yet
				});
			}
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
					if (!newBlocks.some((b) => b.id === event.data.id)) {
						newBlocks.push(event.data);
					}
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
				case 'rating': {
					// Replace-by-axis so resume can re-emit a rating without duplicating it.
					// The DB layer uses INSERT…ON CONFLICT; the client mirrors that semantics
					// so reloading / continuing a generation doesn't briefly double-render a card.
					const idx = entry.ratings.findIndex((r) => r.axis === event.data.axis);
					if (idx >= 0) {
						entry.ratings = entry.ratings.map((r, i) => (i === idx ? event.data : r));
					} else {
						entry.ratings = [...entry.ratings, event.data];
					}
					break;
				}
				case 'phase':
					entry.phase = event.data.phase;
					entry.phaseMessage = event.data.message;
					if (event.data.phase !== 'connecting') {
						entry.liveGeneration = true;
					}
					break;
				case 'error':
					if (event.data.code === 'CloneInProgress' && event.data.repoId != null) {
						entry.cloneInProgress = true;
						entry.cloneRepoId = event.data.repoId;
						entry.isStreaming = false;
					} else if (event.data.code === 'CloneInProgress') {
						// Defensive: if the server omitted repoId we can't poll or
						// auto-retry. Surface a real error so the UI renders a
						// retry button instead of an indeterminate progress bar.
						entry.cloneInProgress = false;
						entry.cloneRepoId = null;
						entry.isStreaming = false;
						entry.streamError = 'Walkthrough could not start: the repository is cloning, but the server did not report which one. Retry to try again.';
					} else {
						entry.streamError = event.data.message;
						entry.isStreaming = false;
					}
					break;
				case 'in-progress':
					// Server says generation is running in the background.
					// Keep isStreaming true — WS will notify on completion.
					entry.walkthroughId = event.data.walkthroughId;
					entry.phase = 'writing';
					entry.phaseMessage = 'Generating walkthrough...';
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
	// A clone poll, if any, is tied to the clone-in-progress state we just
	// cleared out — cancel it too so we don't leak a loop.
	stopClonePoll(prId);
}

/**
 * Abort oldest non-active streams until there's room for a new one.
 * Reset aborted entries so a later visit triggers a fresh fetch — the
 * server's partial cache means the user doesn't lose progress.
 */
function enforceStreamCap(): void {
	while (controllers.size >= MAX_CONCURRENT_STREAMS) {
		let victim: string | null = null;
		for (const prId of controllers.keys()) {
			if (prId === activePrId) continue;
			victim = prId;
			break;
		}
		if (victim === null) break; // only activePrId left — nothing to drop
		abortPr(victim);
		updateEntry(victim, (e) => {
			e.isStreaming = false;
		});
	}
}

export function abort(): void {
	if (activePrId) {
		abortPr(activePrId);
		updateEntry(activePrId, (e) => {
			e.isStreaming = false;
		});
	}
}

// Issues to seed into the fresh entry immediately after creation.
// Set by `regenerate()` before calling `streamWalkthrough()`.
let pendingKeptIssues: WalkthroughIssue[] = [];

export async function regenerate(prId: string, keptIssues?: WalkthroughIssue[]): Promise<void> {
	// Capture the current entry BEFORE aborting so we can extract block context
	const oldEntry = entries.get(prId);

	// Reset animation trackers so the newly-streamed content animates in
	// like a first-time view (stepper/content/summary/issues section fade in,
	// blocks and issue cards stagger). Without this, regenerate would pop
	// content into place with no visual acknowledgment of the new data.
	animatedBlocks.delete(prId);
	animatedIssues.delete(prId);
	animatedContainers.delete(prId);

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

	// Build enriched carried-over issues by resolving each issue's block IDs
	// to their original annotation/content text so the agent can reassess them.
	const enrichedKeptIssues: CarriedOverIssue[] = (keptIssues ?? []).map((issue) => {
		const blockTexts = issue.blockIds.flatMap((blockId) => {
			const block = oldEntry?.blocks.find((b) => b.id === blockId);
			if (!block) return [];
			if (block.type === 'markdown') return [block.content.slice(0, 500)];
			return [block.annotation ?? ''];
		}).filter((text) => text.length > 0);

		return {
			...issue,
			originalContext: blockTexts.join('\n\n'),
		};
	});

	// Await cache invalidation so the subsequent stream request doesn't
	// race and find the old errored walkthrough still in the database.
	try {
		await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/regenerate`, {
			method: 'POST',
			headers: { ...authHeaders(), 'Content-Type': 'application/json' },
			body: JSON.stringify({ keptIssues: enrichedKeptIssues }),
		});
	} catch {
		// If invalidation fails, streamWalkthrough will still attempt a
		// fresh generation — worst case the server resumes the partial.
	}

	// Remove the temp entry so streamWalkthrough creates a clean one
	entries.delete(prId);
	entries = new Map(entries);

	// Seed kept issues so the new entry pre-populates them before streaming.
	// Strip `blockIds` — those ids point into the OLD walkthrough's blocks and
	// are meaningless against the new ones. Block ids are order-based
	// (`block-0`, `block-1`, …), so a stale id can either reference nothing
	// (fewer blocks this time → silent click failure) or coincidentally match
	// a semantically-unrelated new block (click jumps to the wrong step). Both
	// show up to the user as "clicking the issue is buggy." Clearing the link
	// renders kept issues as non-clickable labels until the model re-flags them
	// against a real new block.
	pendingKeptIssues = (keptIssues ?? []).map((i) => ({ ...i, blockIds: [] }));

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
		// Snapshot BEFORE mutation — updateEntry mutates in-place, so reading
		// entry.doneReceived after the call always returns true, making the
		// missingRatings check below permanently false.
		const hadBlocks = entry.blocks.length > 0;
		const hadRatings = entry.ratings.length > 0;
		const wasDone = entry.doneReceived;

		updateEntry(prId, (e) => {
			e.isStreaming = false;
			e.doneReceived = true;
			e.walkthroughId = walkthroughId;
		});
		// Fetch the full walkthrough from cache if:
		// 1. No blocks yet (SSE disconnected early), OR
		// 2. Has blocks but missing ratings and never received the done event
		//    (SSE dropped before the ratings/done phase at the end of generation)
		const missingRatings = hadBlocks && !hadRatings && !wasDone;
		if (activePrId === prId && (!hadBlocks || missingRatings)) {
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

// ── Animated block tracking ─────────────────────────────────────────────────
// Non-reactive — tracks which block IDs have already animated, keyed by PR ID.
// Lives outside `entries` so it survives component remounts.
//
// Why all three maps exist: the walkthrough tab is never unmounted on tab
// switch (the parent just toggles `display: contents` ↔ `display: none`), but
// browsers restart CSS animations on a subtree the moment it re-enters the
// render tree. Without these trackers, every hop back to the Walkthrough tab
// replays all entrance animations. Each tracker is per-PR because tracking
// is meaningful per walkthrough lifetime, and is cleared on `regenerate()`
// so a fresh stream animates again like a first view.
const animatedBlocks = new Map<string, Set<string>>();

// Per-PR tracker of which issue IDs have played their entrance animation.
const animatedIssues = new Map<string, Set<string>>();

// Per-PR tracker of one-shot container animations
// (keys: 'stepper', 'content', 'summary', 'issues-section').
const animatedContainers = new Map<string, Set<string>>();

/** Returns true if this block has already played its entrance animation. */
export function hasBlockAnimated(prId: string, blockId: string): boolean {
	return animatedBlocks.get(prId)?.has(blockId) ?? false;
}

/** Mark a block as having played its entrance animation. */
export function markBlockAnimated(prId: string, blockId: string): void {
	let set = animatedBlocks.get(prId);
	if (!set) {
		set = new Set();
		animatedBlocks.set(prId, set);
	}
	set.add(blockId);
}

/** Returns true if this issue card has already played its entrance animation. */
export function hasIssueAnimated(prId: string, issueId: string): boolean {
	return animatedIssues.get(prId)?.has(issueId) ?? false;
}

/** Mark an issue card as having played its entrance animation. */
export function markIssueAnimated(prId: string, issueId: string): void {
	let set = animatedIssues.get(prId);
	if (!set) {
		set = new Set();
		animatedIssues.set(prId, set);
	}
	set.add(issueId);
}

/** Returns true if this container (stepper/content/summary/issues-section) has already animated. */
export function hasContainerAnimated(prId: string, key: string): boolean {
	return animatedContainers.get(prId)?.has(key) ?? false;
}

/** Mark a container as having played its entrance animation. */
export function markContainerAnimated(prId: string, key: string): void {
	let set = animatedContainers.get(prId);
	if (!set) {
		set = new Set();
		animatedContainers.set(prId, set);
	}
	set.add(key);
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
