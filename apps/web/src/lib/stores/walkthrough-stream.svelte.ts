// ── Walkthrough transport layer ─────────────────────────────────────────────
//
// Owns all network I/O for walkthroughs: SSE streaming, REST hydration,
// abort lifecycle, clone polling, and the WS-complete handler that may
// trigger a re-fetch. Imports reactive state from walkthrough.svelte.ts
// but never the other way around — that one-directional dependency keeps
// the state layer free of transport concerns.

import type {
  CloneStatus,
  RiskLevel,
  WalkthroughBlock,
  WalkthroughIssue,
  WalkthroughPipelinePhase,
  WalkthroughRating,
  WalkthroughSemanticStep,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { API_BASE_URL } from "$lib/api/base-url";
import { api } from "$lib/api/client";
import { runWalkthroughSse } from "$lib/services/walkthrough-sse";
import { updateRepoCloneStatus } from "$lib/stores/prs.svelte";
import { authHeaders } from "$lib/utils/session-token";
import { wtTrace } from "$lib/utils/wt-trace";
import {
  applyEvents,
  clearAnimationTrackers,
  coerceTokenUsage,
  deleteEntry,
  freshEntry,
  setEntry,
  store,
  updateEntry,
} from "./walkthrough.svelte";

// ── Stream cap ──────────────────────────────────────────────────────────────
//
// WebKit caps HTTP/1.1 at ~6 connections per host; each SSE stream holds one
// indefinitely. Without a cap, clicking through enough PRs exhausts the pool
// and short-lived fetches (e.g. /api/prs/:id/files) queue forever.
const MAX_CONCURRENT_STREAMS = 5;

// ── Non-reactive transport state ─────────────────────────────────────────────

// Abort controllers keyed by PR ID. Map iteration order = insertion order,
// giving oldest-first eviction in enforceStreamCap.
//
// `intentional` flips to true when the abort is driven by us (navigation
// away, regenerate, evict-by-cap) rather than by an unexpected stream end.
// streamWalkthrough's finally consults it to decide whether to surface
// the "ended unexpectedly" error.
type ControllerEntry = {
  abort: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  intentional: boolean;
};
const controllers = new Map<string, ControllerEntry>();

// Clone-status pollers keyed by PR ID. One active poller per PR at a time;
// the `cancelled` flag lets either the component's effect cleanup or the
// next poll-start call stop the loop cooperatively between ticks.
const clonePollers = new Map<string, { cancelled: boolean }>();

const CLONE_POLL_INTERVAL_MS = 2000;
const CLONE_POLL_MAX_MS = 10 * 60 * 1000;

// S6: Dedup in-flight hydration requests per prId. Multiple callers
// (mount-effect, WS reconnect, reconciliation poll) can race to hydrate
// the same PR. They share a single in-flight Promise so only one HTTP
// request goes out. Encapsulated inside hydrateFromCache — callers do
// not touch this map directly.
const pendingHydration = new Map<string, Promise<boolean>>();

// In-flight user-initiated actions keyed by prId. Drives the `disabled`
// state on Regenerate / Resume floating buttons so a double-click can't
// fire two concurrent destructive actions during the async
// POST → delete-entry → stream-start dance. Reactive `$state` so reads
// from `$derived` consumers stay reactive; mutations follow the
// Map-reassignment idiom enforced elsewhere in this codebase.
export type PendingAction = "regenerate" | "resume";

const pendingActions = $state({
  map: new Map<string, PendingAction>(),
});

function setPending(prId: string, action: PendingAction): void {
  pendingActions.map.set(prId, action);
  pendingActions.map = new Map(pendingActions.map);
}

function clearPending(prId: string): void {
  if (!pendingActions.map.has(prId)) return;
  pendingActions.map.delete(prId);
  pendingActions.map = new Map(pendingActions.map);
}

/**
 * In-flight destructive action for the given PR's walkthrough, or null.
 * Consumed by the floating-bar derivation to disable Regenerate / Resume
 * during the async dance after the user clicks one.
 */
export function getPendingAction(prId: string): PendingAction | null {
  return pendingActions.map.get(prId) ?? null;
}

// ── Clone polling ──────────────────────────────────────────────────────────

export function stopClonePoll(prId: string): void {
  const p = clonePollers.get(prId);
  if (p) p.cancelled = true;
  clonePollers.delete(prId);
}

export async function pollCloneUntilResolved(prId: string, repoId: string): Promise<void> {
  // Coalesce: if an in-flight poll is already running for this PR, do nothing.
  if (clonePollers.has(prId)) return;
  const token = { cancelled: false };
  clonePollers.set(prId, token);
  const startedAt = Date.now();
  try {
    while (!token.cancelled) {
      const entry = store.entries.get(prId);
      if (!entry?.cloneInProgress || entry.cloneRepoId !== repoId) return;

      let status: CloneStatus = "cloning";
      let error: string | null = null;
      try {
        const { data } = await api.api.repos({ id: repoId })["clone-status"].get();
        if (data && "status" in data) {
          status = data.status;
          error = data.error ?? null;
        }
      } catch {
        // Transient network blip — keep polling.
      }

      if (token.cancelled) return;

      updateRepoCloneStatus(repoId, status, error ?? undefined);

      if (status === "ready") {
        void streamWalkthrough(prId);
        return;
      }
      if (status === "error" || status === "pending") {
        updateEntry(prId, (e) => {
          e.cloneInProgress = false;
          e.cloneRepoId = null;
          e.isStreaming = false;
          e.streamError =
            status === "error"
              ? `Repository clone failed${error ? `: ${error}` : ""}. Retry to try again.`
              : "Repository clone was reset. Retry to try again.";
        });
        return;
      }

      if (Date.now() - startedAt > CLONE_POLL_MAX_MS) {
        updateEntry(prId, (e) => {
          e.cloneInProgress = false;
          e.cloneRepoId = null;
          e.isStreaming = false;
          e.streamError = "Repository clone is taking too long. Retry to try again.";
        });
        return;
      }

      await new Promise((r) => setTimeout(r, CLONE_POLL_INTERVAL_MS));
    }
  } finally {
    if (clonePollers.get(prId) === token) clonePollers.delete(prId);
  }
}

// ── Pre-stream setup ────────────────────────────────────────────────────────

/**
 * Synchronously mark a PR as active and seed a "loading" entry if one doesn't
 * already exist in a usable state. Runs on component mount before the
 * stream-start debounce fires, so the UI renders the skeleton immediately
 * instead of briefly flashing the empty state.
 *
 * Does NOT start a fetch — that's streamWalkthrough's job. The two coordinate
 * via the `controllers` Map: a seeded entry has `isStreaming: true` but no
 * controller, so streamWalkthrough proceeds with the fetch.
 */
export function prepareEntry(prId: string): void {
  store.activePrId = prId;
  if (controllers.has(prId)) return;
  const existing = store.entries.get(prId);
  if (
    existing &&
    existing.summary !== null &&
    existing.blocks.length > 0 &&
    existing.doneReceived &&
    !existing.streamError
  )
    return;
  setEntry(prId, {
    ...freshEntry(),
    isStreaming: false,
    phaseMessage: "",
    streamStartedAt: null,
  });
}

// ── Abort helpers ───────────────────────────────────────────────────────────

export function abortPr(prId: string, intentional: boolean = true): void {
  const ctrl = controllers.get(prId);
  if (ctrl) {
    wtTrace("lifecycle", `abortPr prId=${prId} intentional=${intentional}`);
    ctrl.intentional = intentional;
    ctrl.reader?.cancel().catch(() => {});
    ctrl.reader = null;
    ctrl.abort.abort();
    controllers.delete(prId);
  }
  stopClonePoll(prId);
}

function enforceStreamCap(): void {
  while (controllers.size >= MAX_CONCURRENT_STREAMS) {
    let victim: string | null = null;
    for (const prId of controllers.keys()) {
      if (prId === store.activePrId) continue;
      victim = prId;
      break;
    }
    if (victim === null) break;
    abortPr(victim);
    const victimEntry = store.entries.get(victim);
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
    if (isActivelyGenerating) {
      scheduleReconciliationPoll(victim);
    }
  }
}

// ── Reconciliation poll ─────────────────────────────────────────────────────

/**
 * After an SSE stream closes without a terminal event, poll `hydrateFromCache`
 * with exponential backoff until the server-side job resolves.
 */
function scheduleReconciliationPoll(prId: string, attempt = 0): void {
  const MAX_ATTEMPTS = 8;
  const delayMs = Math.min(1_000 * 2 ** attempt, 30_000);
  wtTrace(
    "lifecycle",
    `scheduleReconciliationPoll prId=${prId} attempt=${attempt} delayMs=${delayMs}`,
  );

  if (attempt === 0) {
    updateEntry(prId, (e) => {
      if (e.isStreaming && !e.doneReceived && !e.streamError) {
        e.phaseMessage = "Reconnecting to walkthrough…";
      }
    });
  }

  setTimeout(async () => {
    const en = store.entries.get(prId);
    if (!en?.isStreaming || en.doneReceived || en.streamError) return;

    if (controllers.has(prId)) {
      if (attempt + 1 < MAX_ATTEMPTS) scheduleReconciliationPoll(prId, attempt + 1);
      return;
    }

    const hit = await hydrateFromCache(prId, { activate: false });

    if (hit) {
      const updated = store.entries.get(prId);
      if (updated?.isStreaming && !updated.doneReceived && attempt + 1 < MAX_ATTEMPTS) {
        scheduleReconciliationPoll(prId, attempt + 1);
      }
    } else if (attempt + 1 < MAX_ATTEMPTS) {
      scheduleReconciliationPoll(prId, attempt + 1);
    }
  }, delayMs);
}

// ── Core streaming ──────────────────────────────────────────────────────────

export async function streamWalkthrough(
  prId: string,
  options?: { activate?: boolean; snapshotAt?: string; lastPhase?: string },
): Promise<void> {
  wtTrace("lifecycle", `streamWalkthrough enter prId=${prId}`);
  if (options?.activate !== false) {
    store.activePrId = prId;
  }
  stopClonePoll(prId);

  const existing = store.entries.get(prId);

  const STALE_STREAM_MS = 10 * 60 * 1000;
  const hasController = controllers.has(prId);
  const isStale =
    hasController &&
    existing?.streamStartedAt != null &&
    !existing.doneReceived &&
    Date.now() - existing.streamStartedAt > STALE_STREAM_MS;
  if (hasController && !isStale) {
    wtTrace("lifecycle", `streamWalkthrough skip prId=${prId} reason=already-streaming`);
    return;
  }

  if (
    existing &&
    existing.summary !== null &&
    existing.blocks.length > 0 &&
    existing.doneReceived &&
    !existing.streamError
  ) {
    wtTrace("lifecycle", `streamWalkthrough skip prId=${prId} reason=already-complete`);
    return;
  }

  abortPr(prId);
  enforceStreamCap();

  const isResumeFromHydratedPartial =
    !!existing &&
    !existing.streamError &&
    !existing.cloneInProgress &&
    !existing.doneReceived &&
    existing.liveGeneration &&
    (existing.summary !== null ||
      existing.semanticSteps.length > 0 ||
      existing.blocks.length > 0 ||
      existing.issues.length > 0 ||
      existing.ratings.length > 0);
  const reusable =
    !!existing &&
    !existing.streamError &&
    !existing.cloneInProgress &&
    existing.summary === null &&
    existing.semanticSteps.length === 0 &&
    existing.blocks.length === 0 &&
    existing.explorationSteps.length === 0 &&
    existing.issues.length === 0 &&
    existing.ratings.length === 0;
  const entry = (reusable || isResumeFromHydratedPartial) && existing ? existing : freshEntry();
  entry.isStreaming = true;
  entry.streamStartedAt = Date.now();
  entry.cloneInProgress = false;
  entry.cloneRepoId = null;
  entry.superseded = false;
  setEntry(prId, entry);

  const abortCtrl = new AbortController();
  const ctrlEntry: ControllerEntry = { abort: abortCtrl, reader: null, intentional: false };
  controllers.set(prId, ctrlEntry);

  try {
    const sseParams = new URLSearchParams();
    if (options?.snapshotAt) sseParams.set("snapshotAt", options.snapshotAt);
    if (options?.lastPhase) sseParams.set("lastPhase", options.lastPhase);
    const sseQs = sseParams.toString();
    const sseUrl = `${API_BASE_URL}/api/reviews/${prId}/walkthrough${sseQs ? `?${sseQs}` : ""}`;
    await runWalkthroughSse({
      url: sseUrl,
      signal: abortCtrl.signal,
      onReaderReady: (reader) => {
        const ctrl = controllers.get(prId);
        if (ctrl) ctrl.reader = reader;
      },
      onEvents: (events) => applyEvents(prId, events),
      explorationStallMessage:
        "Walkthrough stalled — the model explored files for 3 minutes without producing output. Try regenerating.",
      inactivityMessage:
        "Lost connection to the walkthrough server. Check that the local server is running and try again.",
    });
  } catch (e) {
    const aborted = abortCtrl.signal.aborted || (e as Error).name === "AbortError";
    if (!aborted) {
      updateEntry(prId, (en) => {
        en.streamError = e instanceof Error ? e.message : "Stream failed";
        en.isStreaming = false;
      });
      toast.error(e instanceof Error ? e.message : "Walkthrough failed");
    }
  } finally {
    const en = store.entries.get(prId);
    if (en?.isStreaming && !en.doneReceived && !en.streamError && !ctrlEntry.intentional) {
      if (!en.summary) {
        updateEntry(prId, (e) => {
          e.streamError = "Walkthrough generation ended unexpectedly. Try regenerating.";
          e.isStreaming = false;
        });
      } else {
        scheduleReconciliationPoll(prId);
      }
    }
    const current = controllers.get(prId);
    if (current?.abort === abortCtrl) {
      controllers.delete(prId);
    }
  }
}

export async function prefetchWalkthrough(prId: string): Promise<void> {
  const existing = store.entries.get(prId);
  if (existing?.isStreaming) return;
  if (existing && existing.summary !== null && existing.blocks.length > 0 && !existing.streamError)
    return;

  abortPr(prId);

  const abortCtrl = new AbortController();
  const ctrlEntry: ControllerEntry = { abort: abortCtrl, reader: null, intentional: false };
  controllers.set(prId, ctrlEntry);
  enforceStreamCap();
  if (!controllers.has(prId)) return;

  setEntry(prId, freshEntry());

  try {
    await runWalkthroughSse({
      url: `${API_BASE_URL}/api/reviews/${prId}/walkthrough`,
      signal: abortCtrl.signal,
      onReaderReady: (reader) => {
        const ctrl = controllers.get(prId);
        if (ctrl) ctrl.reader = reader;
      },
      onEvents: (events) => applyEvents(prId, events),
      explorationStallMessage: "Walkthrough stalled during prefetch.",
      inactivityMessage: "Walkthrough prefetch appears stuck.",
    });
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      updateEntry(prId, (en) => {
        en.streamError = e instanceof Error ? e.message : "Prefetch failed";
        en.isStreaming = false;
      });
    }
  } finally {
    const en = store.entries.get(prId);
    if (en?.isStreaming && !en.doneReceived && !en.streamError && !en.summary) {
      updateEntry(prId, (e) => {
        e.isStreaming = false;
      });
    }
    controllers.delete(prId);
  }
}

// ── Cache hydration ─────────────────────────────────────────────────────────

/**
 * Read current walkthrough state for `prId` and reconcile it into the
 * reactive store. The only client path that returns walkthrough content
 * without potentially triggering generation. Called from three places:
 *   - `GuidedWalkthrough.onMount` — instant render on cache hit
 *   - `ws.svelte.ts onOpen` — recover missed `walkthrough:complete` for
 *     the active PR after a reconnect
 *   - `scheduleReconciliationPoll` — converge after SSE closes without
 *     a terminal event
 *
 * Concurrent calls for the same `prId` share a single in-flight request
 * via `pendingHydration`; the activate side-effect fires once, under
 * whichever caller's options won the race.
 *
 * @param options.activate — When not `false`, sets `store.activePrId =
 *   prId` on a cache hit. Reconciliation poll passes `false` so
 *   background recovery doesn't steal the user's focus.
 */
export async function hydrateFromCache(
  prId: string,
  options?: { activate?: boolean },
): Promise<boolean> {
  const inflight = pendingHydration.get(prId);
  if (inflight) {
    wtTrace("lifecycle", `hydrateFromCache deduped prId=${prId}`);
    return inflight;
  }

  const promise = doHydrateFromCache(prId, options);
  pendingHydration.set(prId, promise);
  try {
    return await promise;
  } finally {
    pendingHydration.delete(prId);
  }
}

async function doHydrateFromCache(
  prId: string,
  options?: { activate?: boolean },
): Promise<boolean> {
  wtTrace("lifecycle", `hydrateFromCache enter prId=${prId}`);
  const existing = store.entries.get(prId);
  if (
    existing &&
    existing.summary !== null &&
    existing.blocks.length > 0 &&
    existing.doneReceived &&
    !existing.streamError
  ) {
    wtTrace("lifecycle", `hydrateFromCache skip prId=${prId} reason=already-complete`);
    if (options?.activate !== false) {
      store.activePrId = prId;
    }
    return true;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/current`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) {
      wtTrace("lifecycle", `hydrateFromCache prId=${prId} httpStatus=${res.status} → false`);
      return false;
    }

    type WalkthroughPayload = {
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
      generatedBy?: {
        githubUserId: number | null;
        githubLogin: string | null;
        displayName: string | null;
        avatarContent: string | null;
      } | null;
      providerConfig?: {
        provider: string;
        model: string;
        thinkingEffort: string | null;
        contextWindow: string | null;
        maxTurns: number;
      } | null;
    };

    const body = (await res.json()) as
      | { status: "not_found" }
      | {
          status: "complete" | "generating" | "error";
          walkthrough: WalkthroughPayload;
          snapshotAt: string;
        };

    if (body.status === "not_found") {
      wtTrace("lifecycle", `hydrateFromCache prId=${prId} status=not_found → false`);
      return false;
    }

    const wt = body.walkthrough;
    const { status, snapshotAt } = body;
    const isGenerating = status === "generating";
    const isError = status === "error";
    wtTrace(
      "lifecycle",
      `hydrateFromCache prId=${prId} status=${status} blocks=${wt.blocks.length} issues=${wt.issues.length} ratings=${wt.ratings.length} semanticSteps=${wt.semanticSteps?.length ?? 0} hasSentiment=${wt.sentiment !== null && wt.sentiment !== undefined}`,
    );

    const previous = store.entries.get(prId);
    const entry = previous ?? freshEntry();
    const hasRealSummary = wt.summary !== "";
    entry.summary = hasRealSummary ? wt.summary : null;
    entry.riskLevel = hasRealSummary ? wt.riskLevel : null;
    entry.sentiment = wt.sentiment ?? null;
    entry.lastCompletedPhase = wt.lastCompletedPhase ?? (isGenerating ? "none" : "D");
    entry.semanticSteps = (wt.semanticSteps ?? [])
      .slice()
      .sort((a, b) => a.semanticStepIndex - b.semanticStepIndex);
    entry.blocks = wt.blocks;
    entry.issues = wt.issues;
    entry.ratings = wt.ratings;
    entry.walkthroughId = wt.id;
    entry.doneReceived = !isGenerating && !isError;
    entry.isStreaming = isGenerating;
    entry.tokenUsage = coerceTokenUsage(wt.tokenUsage);
    entry.streamError = isError
      ? "Walkthrough generation failed. Resume or regenerate to retry."
      : null;
    entry.superseded = false;
    entry.phase = isGenerating ? "writing" : "finishing";
    entry.phaseMessage = isGenerating ? "Resuming walkthrough…" : "Complete";
    entry.liveGeneration = isGenerating;
    // Attribution: prefer the server's payload; fall back to whatever the
    // previous entry held (set by `onWalkthroughCacheHit`). Preserves the
    // "Loaded from team cache" badge across the immediate cache→complete
    // refetch cycle.
    entry.generatedBy = wt.generatedBy ?? entry.generatedBy ?? null;
    entry.providerConfig = wt.providerConfig ?? entry.providerConfig ?? null;
    if (previous?.source === "remote") entry.source = "remote";
    if (isGenerating) entry.streamStartedAt = Date.now();
    setEntry(prId, entry);
    if (options?.activate !== false) {
      store.activePrId = prId;
    }

    if (isGenerating) {
      const cursorOpts = {
        snapshotAt,
        lastPhase: wt.lastCompletedPhase ?? "none",
        ...(options?.activate !== undefined ? { activate: options.activate } : {}),
      };
      void streamWalkthrough(prId, cursorOpts);
    }

    return true;
  } catch (e) {
    wtTrace(
      "lifecycle",
      `hydrateFromCache prId=${prId} error=${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

// ── Abort / reset ────────────────────────────────────────────────────────────

/**
 * Stop the SSE stream for `prId` and clear its streaming flag. Caller must
 * supply the explicit prId — earlier versions fell back to `store.activePrId`
 * or scanned for any streaming entry, which silently targeted the wrong PR
 * when the PRs-store selection and the walkthrough-store's `activePrId`
 * had drifted (manifested as a dead Stop button).
 */
export function abort(prId: string): void {
  abortPr(prId);
  updateEntry(prId, (e) => {
    e.isStreaming = false;
    e.streamError = null;
  });
}

export async function regenerate(prId: string): Promise<void> {
  if (pendingActions.map.has(prId)) return;
  setPending(prId, "regenerate");
  try {
    clearAnimationTrackers(prId);
    abortPr(prId);
    deleteEntry(prId);
    store.activePrId = prId;

    const entry = freshEntry();
    entry.phaseMessage = "Regenerating...";
    setEntry(prId, entry);

    try {
      await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/regenerate`, {
        method: "POST",
        headers: authHeaders(),
      });
    } catch {
      // Non-fatal — streamWalkthrough will attempt a fresh generation anyway.
    }

    deleteEntry(prId);
    await streamWalkthrough(prId);
  } finally {
    clearPending(prId);
  }
}

export async function resume(prId: string): Promise<void> {
  if (pendingActions.map.has(prId)) return;
  setPending(prId, "resume");
  try {
    updateEntry(prId, (e) => {
      e.streamError = null;
    });
    try {
      const res = await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/resume`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    await streamWalkthrough(prId);
  } finally {
    clearPending(prId);
  }
}

export async function invalidateForPull(prId: string): Promise<void> {
  clearAnimationTrackers(prId);
  abortPr(prId);
  deleteEntry(prId);
  try {
    await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/regenerate`, {
      method: "POST",
      headers: authHeaders(),
    });
  } catch {
    // Non-fatal.
  }
}

/**
 * Called when the review page unmounts. Deactivates the active PR tracking
 * but intentionally keeps the SSE stream alive in `controllers` if the
 * walkthrough is still generating.
 *
 * Why we no longer abort on navigation: each SSE stream occupies one
 * HTTP/1.1 connection slot. Aborting on navigate-away and immediately
 * opening a new one for the destination PR races with the diff-files
 * fetch for that PR — the browser's connection pool (capped at ~6 per
 * host) may not release the old slot before the new fetch queues,
 * causing the diff to appear stuck on "Loading…". By leaving generating
 * streams alive, the connection is already open and no slot is
 * transiently double-counted. `enforceStreamCap` evicts the oldest
 * non-active stream if needed when a new one opens.
 *
 * A non-generating (completed/errored) stream is aborted below so its
 * connection slot is freed promptly. The abort is marked intentional
 * so the finally block doesn't surface an "ended unexpectedly" error.
 */
export function deactivate(): void {
  const activePrId = store.activePrId;
  if (activePrId) {
    const entry = store.entries.get(activePrId);
    const isGenerating = entry?.isStreaming === true && !entry?.doneReceived && !entry?.streamError;
    if (!isGenerating) {
      abortPr(activePrId, true);
    }
  }
  store.activePrId = null;
}

export function reset(): void {
  const activePrId = store.activePrId;
  if (activePrId) {
    abortPr(activePrId);
    deleteEntry(activePrId);
    store.activePrId = null;
  }
}

// ── WS-complete handler ─────────────────────────────────────────────────────
//
// Lives here (not in the state layer) because the "not content complete" path
// calls fetchCachedWalkthrough → streamWalkthrough — both transport functions.

export function onWalkthroughComplete(prId: string, walkthroughId: string): void {
  const entry = store.entries.get(prId);
  if (entry) {
    // Same content predicate as the SSE `done` handler and the hydration
    // fallback — keeps phase-D promotion consistent across all three paths.
    // Sentiment is checked because invariant #12 requires it for a valid
    // `complete` walkthrough; if it's missing locally we re-hydrate below.
    const hadBlocks = entry.blocks.length > 0;
    const hadSummary = entry.summary !== null;
    const hadSentiment = entry.sentiment !== null;
    const hadFullRatings = entry.ratings.length === 9;
    const isContentComplete = hadBlocks && hadSummary && hadSentiment && hadFullRatings;

    if (isContentComplete || store.activePrId === prId) {
      updateEntry(prId, (e) => {
        e.isStreaming = false;
        e.doneReceived = true;
        e.walkthroughId = walkthroughId;
        if (isContentComplete) {
          e.lastCompletedPhase = "D";
        }
      });
      if (store.activePrId === prId && !isContentComplete) {
        fetchCachedWalkthrough(prId);
      }
    } else {
      abortPr(prId, true);
      updateEntry(prId, (e) => {
        e.walkthroughId = walkthroughId;
        e.isStreaming = false;
      });
    }
  } else {
    const stub = freshEntry();
    stub.isStreaming = false;
    stub.doneReceived = true;
    stub.walkthroughId = walkthroughId;
    setEntry(prId, stub);
  }
}

function fetchCachedWalkthrough(prId: string): void {
  abortPr(prId);
  deleteEntry(prId);
  void streamWalkthrough(prId, { activate: false });
}
