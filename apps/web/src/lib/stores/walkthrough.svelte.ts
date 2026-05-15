import type {
	Activity,
	WalkthroughBlock,
	RiskLevel,
	WalkthroughSemanticStep,
	WalkthroughStreamEvent,
	WalkthroughIssue,
	WalkthroughLifecyclePhase,
	WalkthroughPipelinePhase,
	WalkthroughRating,
	WalkthroughTokenUsage,
	CloneStatus,
} from '@revv/shared';
import { API_BASE_URL } from '$lib/api/base-url';
import { authHeaders } from '$lib/utils/session-token';
import { runWalkthroughSse } from '$lib/services/walkthrough-sse';
import { api } from '$lib/api/client';
import { updateRepoCloneStatus } from '$lib/stores/prs.svelte';
import { toast } from 'svelte-sonner';

// ── Per-PR state entry ──────────────────────────────────────────────────────

interface WalkthroughEntry {
	/**
	 * Phase B chapter manifest in declaration order. Each entry owns 0+ atomic
	 * blocks in `blocks` linked by `semanticStepIndex`. Populated from
	 * `add_semantic_step` SSE events during a live stream, or from the cached
	 * walkthrough payload on hydration.
	 */
	semanticSteps: WalkthroughSemanticStep[];
	blocks: WalkthroughBlock[];
	summary: string | null;
	riskLevel: RiskLevel | null;
	/**
	 * Phase C output — "Overall Sentiment" markdown. Null until Phase C
	 * completes. Replaces the old convention of detecting a specially-formatted
	 * markdown block. When this is non-null, any legacy markdown block whose
	 * content starts with `## Overall Sentiment` is suppressed at render time
	 * so rehydrated old walkthroughs don't render both.
	 */
	sentiment: string | null;
	/**
	 * Pointer into the A→B→C→D content pipeline:
	 *   'none' — nothing persisted yet
	 *   'A'    — Phase A (overview + risk) complete
	 *   'B'    — Phase B (diff analysis) complete
	 *   'C'    — Phase C (sentiment) complete
	 *   'D'    — Phase D (all 9 axes rated) complete
	 */
	lastCompletedPhase: WalkthroughPipelinePhase;
	isStreaming: boolean;
	streamError: string | null;
	walkthroughId: string | null;
	doneReceived: boolean;
	/**
	 * True when the server marked this walkthrough `superseded` — a new commit
	 * landed mid-generation and a fresher walkthrough has been created. The UI
	 * renders a banner offering Regenerate when cached/replayed data is in this
	 * state.
	 */
	superseded: boolean;
	explorationSteps: Activity[];
	issues: WalkthroughIssue[];
	ratings: WalkthroughRating[];
	phase: WalkthroughLifecyclePhase;
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
	/**
	 * Cumulative token usage for this PR's walkthrough generation. Updated live
	 * on each `usage` SSE event (one per agent turn / auto-continuation) and
	 * finalized on `done`. Hydrated from the cached JSON payload on resume.
	 * Powers the BottomBar token+context indicator.
	 */
	tokenUsage: WalkthroughTokenUsage;
}

const ZERO_TOKEN_USAGE: WalkthroughTokenUsage = Object.freeze({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
});

/**
 * Coerce an unknown payload (e.g. `tokenUsage` from a cached walkthrough
 * response that the server JSON-parsed from a `'{}'` placeholder) into a
 * fully-populated WalkthroughTokenUsage with every field defaulting to 0.
 */
function coerceTokenUsage(raw: unknown): WalkthroughTokenUsage {
	if (raw === null || typeof raw !== 'object') return { ...ZERO_TOKEN_USAGE };
	const r = raw as Record<string, unknown>;
	const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
	return {
		inputTokens: num(r['inputTokens']),
		outputTokens: num(r['outputTokens']),
		cacheReadInputTokens: num(r['cacheReadInputTokens']),
		cacheCreationInputTokens: num(r['cacheCreationInputTokens']),
	};
}

function freshEntry(): WalkthroughEntry {
	return {
		semanticSteps: [],
		blocks: [],
		summary: null,
		riskLevel: null,
		sentiment: null,
		lastCompletedPhase: 'none',
		isStreaming: true,
		streamError: null,
		walkthroughId: null,
		doneReceived: false,
		superseded: false,
		explorationSteps: [],
		issues: [],
		ratings: [],
		phase: 'connecting',
		phaseMessage: 'Connecting...',
		streamStartedAt: Date.now(),
		liveGeneration: false,
		cloneInProgress: false,
		cloneRepoId: null,
		tokenUsage: { ...ZERO_TOKEN_USAGE },
	};
}

// ── Reactive state ──────────────────────────────────────────────────────────

let entries = $state(new Map<string, WalkthroughEntry>());
let activePrId = $state<string | null>(null);

// Non-reactive — abort controllers keyed by PR ID.
// Map iteration order = insertion order, so iterating gives oldest-first.
//
// `intentional` flips to true when the abort is driven by us (navigation
// away, regenerate, evict-by-cap) rather than by an unexpected stream end.
// streamWalkthrough's finally consults it to decide whether the
// "ended unexpectedly" stream-error message should fire — for an
// intentional disconnect the server-side job is still running and there
// is no error to surface.
type ControllerEntry = {
	abort: AbortController;
	reader: ReadableStreamDefaultReader<Uint8Array> | null;
	intentional: boolean;
};
const controllers = new Map<string, ControllerEntry>();

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
/**
 * Phase B chapter manifest. Empty until the agent opens the first chapter
 * via `add_semantic_step`. The UI renders each entry as a collapsible
 * section containing its atomic blocks.
 */
export function getSemanticSteps(): WalkthroughSemanticStep[] {
	return active()?.semanticSteps ?? [];
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
export function getExplorationSteps(): Activity[] {
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
export function getPhase(): WalkthroughLifecyclePhase {
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
/**
 * Phase C markdown — the "Overall Sentiment" paragraph. Null until Phase C
 * completes. Components render this directly instead of sniffing blocks for a
 * `## Overall Sentiment` header.
 */
export function getSentiment(): string | null {
	return active()?.sentiment ?? null;
}
/** Current pointer into the A→B→C→D content pipeline. */
export function getLastCompletedPhase(): WalkthroughPipelinePhase {
	return active()?.lastCompletedPhase ?? 'none';
}
/**
 * True when the active PR has a walkthrough the server can resume from where
 * it left off — some progress exists, the pipeline never reached Phase D, and
 * no stream is currently open. Gates the **Resume** floating button.
 *
 * A `streamError` does NOT disqualify the entry: an error in the middle of
 * generation leaves the partial content (summary, blocks, issues, ratings)
 * persisted in SQLite. The resume endpoint revives the row from 'error' back
 * to 'generating', resets the retry budget, and the agent picks up via
 * `get_walkthrough_state`. The user gets a "continue from here" path as the
 * default action when partial work exists, instead of being forced into
 * Regenerate (which throws away the partial).
 */
export function getCanResume(): boolean {
	const e = active();
	if (!e) return false;
	if (e.isStreaming) return false;
	if (e.lastCompletedPhase === 'D') return false;
	return e.summary !== null || e.blocks.length > 0;
}
/**
 * True when this walkthrough was marked `superseded` by the server (a newer
 * commit landed mid-generation). Used to render the "this walkthrough is
 * outdated" banner with a Regenerate action.
 */
export function getIsSuperseded(): boolean {
	return active()?.superseded ?? false;
}
/**
 * Cumulative token usage for the active (or specified) PR's walkthrough.
 * Returns a stable zero-shape constant if no entry exists, so the BottomBar
 * can safely derive aggregates without null checks.
 */
export function getTokenUsage(prId?: string): WalkthroughTokenUsage {
	const id = prId ?? activePrId;
	if (!id) return ZERO_TOKEN_USAGE;
	return entries.get(id)?.tokenUsage ?? ZERO_TOKEN_USAGE;
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
	// Commit a fresh object reference so Svelte 5's per-key Map tracking
	// invalidates readers. Mutating in place + reassigning the Map binding
	// is *sometimes* enough, but `$derived` blocks reading
	// `entries.get(prId).isStreaming` can keep a stale cached result if the
	// value object identity at that key never changes — the user-visible
	// symptom is the Stop button persisting until a tab switch forces the
	// $derived to re-evaluate.
	const next = { ...entry };
	updater(next);
	entries.set(prId, next);
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
	// Seed a waiting (not yet streaming) entry so the UI can show a ready
	// state before the user-triggered stream actually begins.
	entries.set(prId, { ...freshEntry(), isStreaming: false, phaseMessage: '', streamStartedAt: null });
	entries = new Map(entries);
}

/**
 * After an SSE stream closes without a terminal event, poll `hydrateFromCache`
 * with exponential backoff. Two recovery paths converge here:
 *
 *  - Server already finished (broadcast missed during the 5s WS timeout +
 *    catchAll, or while the client was reconnecting): `hydrateFromCache`
 *    sees status='complete' and marks the entry done.
 *  - Server is still generating: `hydrateFromCache` returns status='generating'
 *    and internally fires a fresh `streamWalkthrough` that rejoins the live
 *    job. From that point the new SSE owns the stream and these polls become
 *    idle no-ops.
 *
 * Delays start at 1s (not 4s) so the user sees recovery kick in quickly
 * instead of staring at a frozen panel. Total window ~140s before giving up.
 *
 * Stops as soon as:
 *  - the entry is no longer streaming (WS broadcast arrived, or user navigated away)
 *  - hydrateFromCache sees a complete/error status in the DB
 *  - we've exhausted the retry budget
 */
function scheduleReconciliationPoll(prId: string, attempt = 0): void {
	const MAX_ATTEMPTS = 8;
	// Delays: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s (~120s total)
	const delayMs = Math.min(1_000 * Math.pow(2, attempt), 30_000);

	// Surface a phase message on the very first attempt so the user knows the
	// UI is trying to recover rather than silently frozen. Skip on later
	// attempts so a still-running streamWalkthrough can overwrite the phase
	// with its real progress message.
	if (attempt === 0) {
		updateEntry(prId, (e) => {
			if (e.isStreaming && !e.doneReceived && !e.streamError) {
				e.phaseMessage = 'Reconnecting to walkthrough…';
			}
		});
	}

	setTimeout(async () => {
		const en = entries.get(prId);
		// Stop if the WS broadcast already resolved the entry, or the user
		// explicitly stopped/errored, or this entry was evicted.
		if (!en || !en.isStreaming || en.doneReceived || en.streamError) return;

		// If a fresh streamWalkthrough is already in flight (e.g. a previous
		// poll attempt's hydrateFromCache fired one and the SSE is currently
		// connected), there's nothing to reconcile — that SSE is the source
		// of truth. Just schedule the next poll as a no-op safety net.
		if (controllers.has(prId)) {
			if (attempt + 1 < MAX_ATTEMPTS) scheduleReconciliationPoll(prId, attempt + 1);
			return;
		}

		// Re-fetch from the DB. If status is now complete/error this will
		// set isStreaming=false and doneReceived=true (via applyEvents / entry
		// update inside hydrateFromCache), resolving the stuck UI. If status
		// is 'generating', hydrateFromCache itself fires streamWalkthrough
		// which reopens the SSE and rejoins the live job.
		const hit = await hydrateFromCache(prId);

		// If still stuck and budget remains, keep polling.
		if (hit) {
			// hydrateFromCache updated the entry — re-check isStreaming.
			const updated = entries.get(prId);
			if (updated?.isStreaming && !updated.doneReceived && attempt + 1 < MAX_ATTEMPTS) {
				scheduleReconciliationPoll(prId, attempt + 1);
			}
		} else if (attempt + 1 < MAX_ATTEMPTS) {
			scheduleReconciliationPoll(prId, attempt + 1);
		}
	}, delayMs);
}

/**
 * Returns the prIds of all entries currently in an unresolved streaming state
 * (isStreaming=true, no terminal event). Used by the WS reconnect handler to
 * reconcile any walkthroughs that may have completed while the WS was down.
 */
export function getUnresolvedStreamingPrIds(): string[] {
	const result: string[] = [];
	for (const [prId, entry] of entries) {
		if (entry.isStreaming && !entry.doneReceived && !entry.streamError) {
			result.push(prId);
		}
	}
	return result;
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

	// Reuse the prepared entry to avoid resetting exploration state;
	// streamStartedAt is always stamped fresh below. Anything past a
	// freshly-seeded state (error, navigated-away cache, etc.) is discarded
	// for a clean slate — EXCEPT entries hydrated from a `generating` partial
	// (`liveGeneration: true` && summary/blocks present && !doneReceived).
	// Those need to keep their hydrated content so the user keeps seeing it
	// while the SSE stream catches up; the snapshot replay then dedupes by
	// block/issue/rating id inside applyEvents, so duplicates are impossible.
	const isResumeFromHydratedPartial = !!existing
		&& !existing.streamError
		&& !existing.cloneInProgress
		&& !existing.doneReceived
		&& existing.liveGeneration
		&& (existing.summary !== null
			|| existing.semanticSteps.length > 0
			|| existing.blocks.length > 0
			|| existing.issues.length > 0
			|| existing.ratings.length > 0);
	const reusable = !!existing
		&& !existing.streamError
		&& !existing.cloneInProgress
		&& existing.summary === null
		&& existing.semanticSteps.length === 0
		&& existing.blocks.length === 0
		&& existing.explorationSteps.length === 0
		&& existing.issues.length === 0
		&& existing.ratings.length === 0;
	const entry = (reusable || isResumeFromHydratedPartial) && existing ? existing : freshEntry();
	entry.isStreaming = true;
	entry.streamStartedAt = Date.now();
	entry.cloneInProgress = false;
	entry.cloneRepoId = null;
	// Starting a fresh stream implicitly clears any previous superseded marker —
	// the server is about to give us the current HEAD SHA's walkthrough (the
	// one that superseded the old one, or a fresh generation of it).
	entry.superseded = false;
	entries.set(prId, entry);
	entries = new Map(entries);

	const abortCtrl = new AbortController();
	const ctrlEntry: ControllerEntry = { abort: abortCtrl, reader: null, intentional: false };
	controllers.set(prId, ctrlEntry);

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
				'Lost connection to the walkthrough server. Check that the local server is running and try again.',
		});
	} catch (e) {
		// Treat any throw after the abort signal fired as an intentional abort,
		// regardless of the error's name. Some transports surface aborted
		// reads as `TypeError`/`NetworkError` rather than `AbortError`, which
		// would otherwise leak through as a fake streamError and leave the
		// entry stuck in `isStreaming: true` with a misleading error message.
		const aborted =
			abortCtrl.signal.aborted || (e as Error).name === 'AbortError';
		if (!aborted) {
			updateEntry(prId, (en) => {
				en.streamError = e instanceof Error ? e.message : 'Stream failed';
				// A real load failure means we're not streaming anymore. Without
				// this, the Stop button keeps rendering (gated on isStreaming)
				// even though the connection is dead, and clicking it cannot
				// transition the UI to a Resume/Regenerate state.
				en.isStreaming = false;
			});
			toast.error(e instanceof Error ? e.message : 'Walkthrough failed');
		}
	} finally {
		const en = entries.get(prId);
		// If the stream ended but we never received a terminal event (done/error/in-progress),
		// and the entry is still marked as streaming, check what happened.
		// Skip this branch entirely for intentional aborts (navigation away,
		// regenerate, cap-eviction) — the server-side job is still running and
		// the next streamWalkthrough/hydrateFromCache will re-attach.
		if (
			en?.isStreaming &&
			!en.doneReceived &&
			!en.streamError &&
			!ctrlEntry.intentional
		) {
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
			} else {
				// Partial data exists — server is still generating in background.
				// The WS walkthrough:complete broadcast is the primary signal, but
				// it can be silently swallowed (5s timeout + catchAll on server).
				// Schedule a reconciliation poll as a safety net so the UI doesn't
				// stay stuck indefinitely waiting for a broadcast that may never arrive.
				scheduleReconciliationPoll(prId);
			}
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
					/**
					 * 'complete' — final walkthrough; render inline, no SSE.
					 * 'generating' — resumed/in-flight job on the server. Hydrate
					 *   whatever partial content already landed, then open the SSE
					 *   stream so the UI receives the rest as it's written. Without
					 *   this branch the resume-on-restart case shows the Generate
					 *   button while the server is already producing the walkthrough.
					 * 'superseded' — left as a future hook; the endpoint doesn't
					 *   currently return this, but the field is read defensively.
					 */
					status?: 'complete' | 'generating' | 'superseded';
					walkthrough: {
						id: string;
						summary: string;
						riskLevel: RiskLevel;
						sentiment?: string | null;
						lastCompletedPhase?: WalkthroughPipelinePhase;
						semanticSteps?: WalkthroughSemanticStep[];
						blocks: WalkthroughBlock[];
						issues: WalkthroughIssue[];
						ratings: WalkthroughRating[];
						tokenUsage: unknown;
						reviewSessionId: string;
					};
			  };

		if (!body.cached) return false;

		const wt = body.walkthrough;
		// `status` lives at the top level of the response; older clients that
		// expected it on the walkthrough object won't see it, but new server
		// builds always set it. Default 'complete' preserves the original
		// behavior for any caller still hitting an old server build.
		const status = body.status ?? 'complete';
		const isGenerating = status === 'generating';

		// Hydrate the entry directly from JSON — no SSE round-trip needed for
		// the complete case. For the generating case we still hydrate the
		// partial content here so the UI can render what we have immediately,
		// then open the SSE stream below for the remaining writes.
		const entry = entries.get(prId) ?? freshEntry();
		// `createPartial` seeds the row with summary='' / riskLevel='low' as a
		// placeholder before Phase A runs. Mirror the SSE handler's guard:
		// treat an empty placeholder as "no summary yet" so the loading
		// skeleton renders instead of a content view with an empty Overview.
		const hasRealSummary = wt.summary !== '';
		entry.summary = hasRealSummary ? wt.summary : null;
		entry.riskLevel = hasRealSummary ? wt.riskLevel : null;
		// Sentiment and lastCompletedPhase are first-class fields on the cached
		// row. Fall back to null / 'D' for rehydrated pre-pipeline complete
		// rows; for generating rows the server reports the actual phase pointer
		// so the A→B→C→D dot indicator stays accurate during the resume.
		entry.sentiment = wt.sentiment ?? null;
		entry.lastCompletedPhase = wt.lastCompletedPhase ?? (isGenerating ? 'none' : 'D');
		entry.semanticSteps = (wt.semanticSteps ?? [])
			.slice()
			.sort((a, b) => a.semanticStepIndex - b.semanticStepIndex);
		entry.blocks = wt.blocks;
		entry.issues = wt.issues;
		entry.ratings = wt.ratings;
		entry.walkthroughId = wt.id;
		entry.doneReceived = !isGenerating;
		entry.isStreaming = isGenerating;
		// Hydrate the BottomBar indicator from the cached row. For 'generating'
		// rows this is typically the zero placeholder (`{}`) — coerceTokenUsage
		// normalizes that to all-zeros, and subsequent live `usage` events fill
		// the real counts in as continuations complete.
		entry.tokenUsage = coerceTokenUsage(wt.tokenUsage);
		entry.streamError = null;
		entry.superseded = status === 'superseded';
		entry.phase = isGenerating ? 'writing' : 'finishing';
		entry.phaseMessage = isGenerating ? 'Resuming walkthrough…' : 'Complete';
		// `liveGeneration` gates the progress stepper. A resumed job IS live
		// generation — the server is actively writing — so the stepper should
		// show through to completion just like it would for a fresh stream.
		entry.liveGeneration = isGenerating;
		// Stamp a fresh streamStartedAt for the resume so the elapsed timer
		// counts the wait the user actually sees (we don't have the original
		// generation start time, and surfacing a stale negative-ish number
		// from a previous app session would be worse than restarting at 0).
		if (isGenerating) entry.streamStartedAt = Date.now();
		entries.set(prId, entry);
		entries = new Map(entries);

		activePrId = prId;

		if (isGenerating) {
			// The server already has a live job for this PR (registered via
			// resumePending or still alive from before a UI reconnect).
			// streamWalkthrough subscribes to it — its snapshot replay is
			// idempotent w.r.t. the partial we just hydrated (block ids /
			// issue ids / rating axes dedupe inside applyEvents).
			void streamWalkthrough(prId);
		}

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
	const ctrlEntry: ControllerEntry = { abort: abortCtrl, reader: null, intentional: false };
	controllers.set(prId, ctrlEntry);

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
				case 'sentiment':
					// Phase C output — the "Overall Sentiment" paragraph. Arrives
					// as a discrete event now; components read entry.sentiment
					// instead of sniffing markdown blocks for a "## Overall
					// Sentiment" header.
					entry.sentiment = event.data.sentiment;
					break;
				case 'semantic-step': {
					// Replace-by-index so a re-emit on resume doesn't duplicate
					// chapters (mirrors the SQL onConflictDoUpdate semantics). New
					// chapters are appended in declaration order; the agent emits
					// in monotonic `semanticStepIndex` so the array stays sorted.
					const idx = entry.semanticSteps.findIndex(
						(s) => s.semanticStepIndex === event.data.semanticStepIndex,
					);
					if (idx >= 0) {
						entry.semanticSteps = entry.semanticSteps.map((s, i) =>
							i === idx ? event.data : s,
						);
					} else {
						entry.semanticSteps = [
							...entry.semanticSteps,
							event.data,
						].sort((a, b) => a.semanticStepIndex - b.semanticStepIndex);
					}
					break;
				}
				case 'block': {
					// Upsert-by-id: replace an existing block if one matches
					// the incoming id (covers chat-edit `update_block` and
					// post-completion block replays). New ids append.
					if (!newBlocks) newBlocks = [...entry.blocks];
					const bi = newBlocks.findIndex((b) => b.id === event.data.id);
					if (bi >= 0) {
						newBlocks[bi] = event.data;
					} else {
						newBlocks.push(event.data);
					}
					break;
				}
				case 'done':
					entry.walkthroughId = event.data.walkthroughId;
					entry.doneReceived = true;
					entry.isStreaming = false;
					// Final accumulated usage. Also covers cache replays where
					// only `done` fires (no intermediate `usage` events).
					entry.tokenUsage = coerceTokenUsage(event.data.tokenUsage);
					break;
				case 'usage':
					// Live per-turn running tally. Server emits one after each
					// auto-continuation accumulates, so the BottomBar updates
					// without waiting for the terminal `done`.
					entry.tokenUsage = coerceTokenUsage(event.data.tokenUsage);
					break;
				case 'exploration':
					entry.explorationSteps = [...entry.explorationSteps, event.data];
					break;
				case 'issue': {
					// Upsert-by-id: replace an existing issue if one matches
					// the incoming id (covers chat-edit `update_issue` and
					// post-completion replays). New ids append.
					const ii = entry.issues.findIndex((i) => i.id === event.data.id);
					if (ii >= 0) {
						entry.issues = entry.issues.map((i, x) =>
							x === ii ? event.data : i,
						);
					} else {
						entry.issues = [...entry.issues, event.data];
					}
					break;
				}
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
				case 'phase:advanced':
					// Monotonic pointer into the A→B→C→D pipeline. Drives the
					// 4-dot header progress indicator independently of the UI
					// lifecycle phase (`phase` event), which reflects what the
					// agent is *doing* rather than what it has persisted.
					entry.lastCompletedPhase = event.data.lastCompletedPhase;
					entry.liveGeneration = true;
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
			case 'thinking':
				// Heartbeat — model is active but hasn't produced content yet.
				// No state change needed; this event exists solely to unblock
				// the stream guard's first-event timer.
				break;
			// ── Chat-edit deletion events (CLAUDE.md invariant #7
			// carve-out). Arrive only via the `walkthrough:edited` WS
			// envelope after a walkthrough has completed; the generation
			// SSE path never emits them.
			case 'block:deleted':
				if (!newBlocks) newBlocks = [...entry.blocks];
				newBlocks = newBlocks.filter((b) => b.id !== event.data.id);
				break;
			case 'rating:deleted':
				entry.ratings = entry.ratings.filter(
					(r) => r.axis !== event.data.axis,
				);
				break;
			case 'issue:deleted':
				entry.issues = entry.issues.filter((i) => i.id !== event.data.id);
				break;
			case 'semantic-step:deleted': {
				const idx = event.data.semanticStepIndex;
				entry.semanticSteps = entry.semanticSteps.filter(
					(s) => s.semanticStepIndex !== idx,
				);
				// Also drop any blocks orphaned by the chapter removal so the
				// UI doesn't try to render headless atomic blocks.
				if (!newBlocks) newBlocks = [...entry.blocks];
				newBlocks = newBlocks.filter((b) => b.semanticStepIndex !== idx);
				break;
			}
			}
		}

		if (newBlocks) {
			entry.blocks = newBlocks;
		}
	});
}

// ── Abort / reset ───────────────────────────────────────────────────────────

function abortPr(prId: string, intentional: boolean = true): void {
	const ctrl = controllers.get(prId);
	if (ctrl) {
		ctrl.intentional = intentional;
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
		// Only set isStreaming=false if NOT actively generating. For streams
		// mid-generation (server still running), keep isStreaming=true so the
		// sidebar and detail view continue to show a progress indicator.
		const victimEntry = entries.get(victim);
		const isActivelyGenerating =
			victimEntry !== undefined &&
			!victimEntry.doneReceived &&
			!victimEntry.streamError &&
			victimEntry.summary !== null;
		if (!isActivelyGenerating) {
			updateEntry(victim, (e) => {
				e.isStreaming = false;
			});
		}
		// Schedule a reconciliation poll so the UI catches up even if the WS
		// walkthrough:complete broadcast is missed (5 s timeout).
		if (isActivelyGenerating) {
			scheduleReconciliationPoll(victim);
		}
	}
}

export function abort(): void {
	// Find a PR to abort. Prefer the active one, but fall back to any
	// streaming entry — the Stop button is gated on `entry.isStreaming`,
	// so if the user can see it, there must be a streaming entry to clear
	// even if `activePrId` got out of sync (e.g. a stale `deactivate()`).
	let prId = activePrId;
	if (!prId) {
		for (const [id, entry] of entries) {
			if (entry.isStreaming) {
				prId = id;
				break;
			}
		}
	}
	if (!prId) return;

	abortPr(prId);
	updateEntry(prId, (e) => {
		e.isStreaming = false;
		// Clear any stale streamError so getCanResume() can flip true and
		// the Resume button appears. Without this, a prior load failure
		// that left streamError set would suppress Resume after the user
		// stops, leaving the walkthrough in a dead-end state.
		e.streamError = null;
	});
}

export async function regenerate(prId: string): Promise<void> {
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

/**
 * Manually resume a walkthrough the user previously stopped via `abort()` OR
 * that ended in `status='error'`. Unlike `regenerate`, the existing entry is
 * preserved — partial blocks / summary stay on screen while the SSE re-opens.
 *
 * The server revives error rows back to `'generating'` and resets the retry
 * counter as part of the resume call (see `resumeWalkthroughHandler`), so
 * from the client's perspective both stopped-by-user and errored states use
 * the same code path. We clear the local `streamError` first so the entry
 * qualifies for `streamWalkthrough`'s rehydrate-from-partial fast path
 * (which gates on `!streamError`) and the user sees seamless continuation
 * instead of a flicker back to the title block.
 *
 * No-ops silently if the server returns a non-OK status (most likely 404
 * because the row was superseded by a head-SHA advance). The user can still
 * click Regenerate.
 */
export async function resume(prId: string): Promise<void> {
	updateEntry(prId, (e) => {
		e.streamError = null;
	});
	try {
		const res = await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/resume`, {
			method: 'POST',
			headers: authHeaders(),
		});
		if (!res.ok) return;
	} catch {
		return;
	}
	await streamWalkthrough(prId);
}

/**
 * Invalidate the walkthrough for a PR after a Pull without starting a new
 * stream. Used by the Pull button so the user sees the "Generate walkthrough"
 * button and opts in explicitly, rather than burning tokens on every pull.
 *
 * Mirrors `regenerate()` but skips the placeholder entry and `streamWalkthrough`
 * call. After this returns the entries Map has no entry for the PR, so
 * GuidedWalkthrough's onMount → hydrateFromCache miss will surface the
 * Generate button.
 */
export async function invalidateForPull(prId: string): Promise<void> {
	// Reset animation trackers so any later generation animates in fresh.
	animatedBlocks.delete(prId);
	animatedIssues.delete(prId);
	animatedContainers.delete(prId);

	// Abort any in-flight SSE and wipe local state immediately so the UI
	// transitions to the "no walkthrough" state without waiting for the server.
	abortPr(prId);
	entries.delete(prId);
	entries = new Map(entries);

	// Cancel the server-side job and invalidate the cached walkthrough row so
	// hydrateFromCache returns a miss on the next mount.
	try {
		await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/regenerate`, {
			method: 'POST',
			headers: authHeaders(),
		});
	} catch {
		// Non-fatal: the local state is already cleared, so the Generate button
		// will appear. The stale server row will be superseded on the next pull
		// or explicit generation.
	}
}

/**
 * Called when the review page unmounts (user navigates to a different PR or
 * away entirely). We deactivate the active PR tracking but intentionally
 * keep the SSE stream alive in `controllers` if the walkthrough is still
 * generating.
 *
 * Why we no longer abort on navigation:
 * Each SSE stream occupies one HTTP/1.1 connection slot. Aborting on
 * navigate-away and immediately opening a new one for the destination PR
 * races with the diff-files fetch for that PR — the browser's connection
 * pool (capped at ~6 per host) may not release the old slot before the new
 * fetch queues, causing the diff to appear stuck on "Loading…". By leaving
 * generating streams alive, the connection is already open and no slot is
 * transiently double-counted. `enforceStreamCap()` evicts the oldest
 * non-active stream if needed when a new one opens.
 *
 * The original concern ("next mount short-circuits at controllers.has and
 * appears frozen") is addressed in `streamWalkthrough`, which checks for
 * stale streams (STALE_STREAM_MS = 10 min) and re-opens when appropriate.
 * A non-generating (completed / errored) stream is aborted below so its
 * connection slot is freed promptly.
 *
 * Marks the abort as `intentional: true` so streamWalkthrough's finally
 * block doesn't surface an "ended unexpectedly" error.
 * The entry's `isStreaming` flag stays true so `getPrWalkthroughStatus`
 * continues to report 'generating' from the sidebar/topbar perspective
 * until the WS `walkthrough:complete` lands or the user navigates back.
 */
export function deactivate(): void {
	if (activePrId) {
		const entry = entries.get(activePrId);
		// Only abort if the stream is NOT actively generating — i.e., it's
		// already done, errored, or was never streaming. An active generating
		// stream is left in `controllers` so it keeps its HTTP connection slot
		// and doesn't race with the destination PR's diff-files fetch.
		const isGenerating = entry?.isStreaming === true && !entry?.doneReceived && !entry?.streamError;
		if (!isGenerating) {
			abortPr(activePrId, true);
		}
	}
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
		// Snapshot BEFORE mutation — updateEntry mutates in-place, so the two
		// predicates below have to read pre-mutation state. The two checks
		// differ on purpose: the laxer one decides whether to mark the entry
		// done locally (a non-active PR will re-hydrate on next visit anyway),
		// the stricter one decides whether an active PR needs an immediate
		// re-fetch from the DB cache.
		const hadBlocks = entry.blocks.length > 0;
		const hadSummary = entry.summary !== null;
		const hadSentiment = entry.sentiment !== null;
		const hadFullRatings = entry.ratings.length === 9;
		const wasDone = entry.doneReceived;
		const canMarkDoneLocally = hadBlocks && hadSummary && hadFullRatings;
		const isContentComplete =
			hadBlocks && hadSummary && hadSentiment && hadFullRatings && wasDone;

		if (canMarkDoneLocally || activePrId === prId) {
			updateEntry(prId, (e) => {
				e.isStreaming = false;
				e.doneReceived = true;
				e.walkthroughId = walkthroughId;
			});
			if (activePrId === prId && !isContentComplete) {
				fetchCachedWalkthrough(prId);
			}
		} else {
			// Partial in-memory entry for a non-active PR. Marking
			// `doneReceived: true` here would make the next mount's
			// `prepareEntry` / `hydrateFromCache` early-return on the
			// "already complete" check at lines 348-349 / 494-503 and
			// surface stale partial content. Stash the walkthroughId so
			// the next visit knows what id the row resolves to, and leave
			// `doneReceived: false` so the next mount's hydrateFromCache
			// fetches the canonical row from the server and overwrites the
			// partial state.
			//
			// However, we DO abort the SSE controller here: the server just
			// confirmed generation is complete, so there's nothing left to
			// stream. Keeping the controller open would permanently hold an
			// HTTP/1.1 connection slot for a stream that will never deliver
			// new events. `enforceStreamCap` can't evict it because it only
			// runs when opening a new stream.
			abortPr(prId, true);
			updateEntry(prId, (e) => {
				e.walkthroughId = walkthroughId;
				e.isStreaming = false;
			});
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

/**
 * Stamp `submittedAt` on the given walkthrough issues of the given PR so the
 * UI's "already posted to GitHub" treatment renders immediately after a
 * Submit / Approve succeeds. The server has already persisted the same value
 * onto the walkthrough_issues rows, so this mirror survives refreshes via
 * the next cache hydrate / SSE replay.
 *
 * Unknown ids are ignored — the walkthrough may have been regenerated between
 * the user selecting the issues and the submit landing.
 */
export function markIssuesAsSubmitted(
	prId: string,
	issueIds: readonly string[],
	submittedAt: string,
): void {
	if (issueIds.length === 0) return;
	const idSet = new Set(issueIds);
	updateEntry(prId, (entry) => {
		entry.issues = entry.issues.map((i) =>
			idSet.has(i.id) ? { ...i, submittedAt } : i,
		);
	});
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

/**
 * Apply a chat-driven post-completion edit broadcast (CLAUDE.md invariant #7
 * carve-out). The route emits a `walkthrough:edited` WS envelope wrapping a
 * single {@link WalkthroughStreamEvent}; we route it through the same
 * reducer the generation SSE path uses so all the upsert / delete semantics
 * stay single-sourced.
 *
 * Drops the event when:
 *   - We have no entry for this PR (user hasn't loaded it yet — they'll
 *     re-fetch on visit via `hydrateFromCache`).
 *   - The entry's `walkthroughId` is set and doesn't match the incoming id
 *     (stale broadcast for a superseded walkthrough).
 */
export function onWalkthroughEdited(
	prId: string,
	walkthroughId: string,
	event: WalkthroughStreamEvent,
): void {
	const entry = entries.get(prId);
	if (!entry) return;
	if (entry.walkthroughId && entry.walkthroughId !== walkthroughId) return;
	applyEvents(prId, [event]);
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
