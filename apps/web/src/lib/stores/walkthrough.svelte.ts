// ── Walkthrough store ───────────────────────────────────────────────────────
//
// Single module covering reactive state, the event reducer, the
// global-SSE entry point, and the few REST helpers needed for
// regenerate/resume/hydrate/abort. Replaces the previous three-layer
// split (state + transport + ui-state projection) — once walkthrough
// events moved to the global SSE bus the per-PR streaming machinery
// (controllers, stream cap, snapshot replay, reconciliation poll) was
// no longer needed and the layering carried more weight than it earned.
//
// Lifecycle:
//   1. `events.svelte.ts` opens the global SSE and dispatches every
//      `walkthrough:event` envelope through `onWalkthroughEvent`.
//   2. Component mounts call `prepareEntry` (sync seed) + `hydrateFromCache`
//      (REST snapshot). If the server is still generating, subsequent
//      content events arrive over the same SSE without any per-PR
//      subscription.
//   3. Regenerate / resume hit a REST endpoint; the server fires
//      `lifecycle:*` events that the reducer applies.

import type {
  Activity,
  CloneStatus,
  RiskLevel,
  WalkthroughBlock,
  WalkthroughIssue,
  WalkthroughLifecyclePhase,
  WalkthroughPipelinePhase,
  WalkthroughRating,
  WalkthroughSemanticStep,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { API_BASE_URL } from "$lib/api/base-url";
import { api } from "$lib/api/client";
import { updateRepoCloneStatus } from "$lib/stores/prs.svelte";
import { authHeaders } from "$lib/utils/session-token";
import { wtTrace } from "$lib/utils/wt-trace";

// ── Entry shape ─────────────────────────────────────────────────────────────

export interface WalkthroughEntry {
  semanticSteps: WalkthroughSemanticStep[];
  blocks: WalkthroughBlock[];
  summary: string | null;
  riskLevel: RiskLevel | null;
  sentiment: string | null;
  lastCompletedPhase: WalkthroughPipelinePhase;
  isStreaming: boolean;
  streamError: string | null;
  walkthroughId: string | null;
  doneReceived: boolean;
  superseded: boolean;
  explorationSteps: Activity[];
  issues: WalkthroughIssue[];
  ratings: WalkthroughRating[];
  phase: WalkthroughLifecyclePhase;
  phaseMessage: string;
  streamStartedAt: number | null;
  liveGeneration: boolean;
  cloneInProgress: boolean;
  cloneRepoId: string | null;
  tokenUsage: WalkthroughTokenUsage;
  source: "local" | "remote";
  generatedBy: {
    githubUserId: number | null;
    githubLogin: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
  providerConfig: {
    provider: string;
    model: string;
    thinkingEffort: string | null;
    contextWindow: string | null;
    maxTurns: number;
  } | null;
}

export const ZERO_TOKEN_USAGE: WalkthroughTokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});

export function coerceTokenUsage(raw: unknown): WalkthroughTokenUsage {
  if (raw === null || typeof raw !== "object") return { ...ZERO_TOKEN_USAGE };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheReadInputTokens: num(r.cacheReadInputTokens),
    cacheCreationInputTokens: num(r.cacheCreationInputTokens),
  };
}

export function freshEntry(): WalkthroughEntry {
  return {
    semanticSteps: [],
    blocks: [],
    summary: null,
    riskLevel: null,
    sentiment: null,
    lastCompletedPhase: "none",
    isStreaming: true,
    streamError: null,
    walkthroughId: null,
    doneReceived: false,
    superseded: false,
    explorationSteps: [],
    issues: [],
    ratings: [],
    phase: "connecting",
    phaseMessage: "Connecting...",
    streamStartedAt: Date.now(),
    liveGeneration: false,
    cloneInProgress: false,
    cloneRepoId: null,
    tokenUsage: { ...ZERO_TOKEN_USAGE },
    source: "local",
    generatedBy: null,
    providerConfig: null,
  };
}

// ── Reactive state ──────────────────────────────────────────────────────────

export const store = $state({
  entries: new Map<string, WalkthroughEntry>(),
  activePrId: null as string | null,
  /**
   * Per-walkthroughId monotonic seq cursor. Set by `hydrateFromCache`
   * (from the REST snapshot's `seqAt`) and advanced by every applied
   * `walkthrough:event` envelope. The reducer drops envelopes with
   * `seq <= lastSeenSeq[walkthroughId]` defensively — they're either a
   * re-delivery during EventSource reconnect or content already covered
   * by a more recent REST snapshot.
   */
  lastSeenSeq: new Map<string, number>(),
});

// `_active` is the single reactive derivation that resolves the current PR's
// walkthrough entry. Do NOT "simplify" this back to a plain function — Svelte
// 5's dependency tracking through a plain function → Map.get() across module
// boundaries silently kept a stale cached result, manifesting as floating
// action buttons stuck on "Stop" until a tab switch forced the $derived to
// re-evaluate.
const _active: WalkthroughEntry | undefined = $derived.by(() => {
  if (!store.activePrId) return undefined;
  return store.entries.get(store.activePrId);
});

// ── Mutation helpers ────────────────────────────────────────────────────────

export function setEntry(prId: string, entry: WalkthroughEntry): void {
  store.entries.set(prId, entry);
  store.entries = new Map(store.entries);
}

export function deleteEntry(prId: string): void {
  store.entries.delete(prId);
  store.entries = new Map(store.entries);
}

export function updateEntry(prId: string, updater: (e: WalkthroughEntry) => void): void {
  const entry = store.entries.get(prId);
  if (!entry) {
    wtTrace("store", `updateEntry-noop prId=${prId} reason=no-entry`);
    return;
  }
  const next = { ...entry };
  updater(next);
  store.entries.set(prId, next);
  store.entries = new Map(store.entries);
}

// ── Getters ─────────────────────────────────────────────────────────────────

export function getActiveEntry(): WalkthroughEntry | undefined {
  return _active;
}

export function getBlocks(): WalkthroughBlock[] {
  return _active?.blocks ?? [];
}
export function getSemanticSteps(): WalkthroughSemanticStep[] {
  return _active?.semanticSteps ?? [];
}
export function getSummary(): string | null {
  return _active?.summary ?? null;
}
export function getRiskLevel(): RiskLevel | null {
  return _active?.riskLevel ?? null;
}
export function getIsStreaming(): boolean {
  return _active?.isStreaming ?? false;
}
export function getStreamError(): string | null {
  return _active?.streamError ?? null;
}
export function getWalkthroughId(): string | null {
  return _active?.walkthroughId ?? null;
}
export function getExplorationSteps(): Activity[] {
  return _active?.explorationSteps ?? [];
}
export function getIssues(): WalkthroughIssue[] {
  return _active?.issues ?? [];
}
export function getIssuesForFile(filePath: string): WalkthroughIssue[] {
  const issues = _active?.issues ?? [];
  return issues.filter((i) => i.filePath === filePath);
}
export function getRatings(): WalkthroughRating[] {
  return _active?.ratings ?? [];
}
export function getPhase(): WalkthroughLifecyclePhase {
  return _active?.phase ?? "connecting";
}
export function getPhaseMessage(): string {
  return _active?.phaseMessage ?? "Connecting...";
}
export function getStreamStartedAt(): number | null {
  return _active?.streamStartedAt ?? null;
}
export function getIsLiveGeneration(): boolean {
  return _active?.liveGeneration ?? false;
}
export function getCloneInProgress(): boolean {
  return _active?.cloneInProgress ?? false;
}
export function getCloneRepoId(): string | null {
  return _active?.cloneRepoId ?? null;
}
export function getSentiment(): string | null {
  return _active?.sentiment ?? null;
}
export function getLastCompletedPhase(): WalkthroughPipelinePhase {
  return _active?.lastCompletedPhase ?? "none";
}
export function getIsSuperseded(): boolean {
  return _active?.superseded ?? false;
}
export function getSource(): "local" | "remote" {
  return _active?.source ?? "local";
}
export function getGeneratedBy(): WalkthroughEntry["generatedBy"] {
  return _active?.generatedBy ?? null;
}
export function getProviderConfig(): WalkthroughEntry["providerConfig"] {
  return _active?.providerConfig ?? null;
}
export function getTokenUsage(prId?: string): WalkthroughTokenUsage {
  const id = prId ?? store.activePrId;
  if (!id) return ZERO_TOKEN_USAGE;
  return store.entries.get(id)?.tokenUsage ?? ZERO_TOKEN_USAGE;
}

// ── State queries ───────────────────────────────────────────────────────────

export function getPrWalkthroughStatus(prId: string): "idle" | "generating" | "complete" | "error" {
  const entry = store.entries.get(prId);
  if (!entry) return "idle";
  if (entry.isStreaming) return "generating";
  if (entry.streamError) return "error";
  if (entry.summary) return "complete";
  return "idle";
}

// ── UI state projection ─────────────────────────────────────────────────────

export type WalkthroughUiState =
  | { kind: "absent" }
  | { kind: "idle" }
  | { kind: "cloning"; repoId: string }
  | { kind: "streaming"; phase: WalkthroughLifecyclePhase }
  | { kind: "resumable"; lastPhase: WalkthroughPipelinePhase }
  | { kind: "complete" }
  | { kind: "complete-stale" }
  | { kind: "error-empty"; message: string }
  | { kind: "error-partial"; message: string; lastPhase: WalkthroughPipelinePhase };

const _uiState: WalkthroughUiState = $derived.by(() => {
  const e = _active;
  if (!e) return { kind: "absent" };
  if (e.cloneInProgress && e.cloneRepoId) {
    return { kind: "cloning", repoId: e.cloneRepoId };
  }
  if (e.isStreaming) return { kind: "streaming", phase: e.phase };

  const hasPartial = e.summary !== null || e.blocks.length > 0;

  if (e.streamError) {
    return hasPartial
      ? { kind: "error-partial", message: e.streamError, lastPhase: e.lastCompletedPhase }
      : { kind: "error-empty", message: e.streamError };
  }
  if (e.doneReceived && e.lastCompletedPhase === "D") {
    return e.superseded ? { kind: "complete-stale" } : { kind: "complete" };
  }
  if (hasPartial) {
    return { kind: "resumable", lastPhase: e.lastCompletedPhase };
  }
  return { kind: "idle" };
});

export function getWalkthroughUiState(): WalkthroughUiState {
  return _uiState;
}

// ── Pending action tracker ──────────────────────────────────────────────────
//
// Drives the `disabled` state on Regenerate / Resume floating buttons so a
// double-click can't fire two concurrent destructive actions during the async
// POST → reset-entry → SSE-event dance.

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

export function getPendingAction(prId: string): PendingAction | null {
  return pendingActions.map.get(prId) ?? null;
}

// ── Event reducer ───────────────────────────────────────────────────────────

export function applyEvents(prId: string, events: WalkthroughStreamEvent[]): void {
  if (events.length > 0) {
    const types = events.map((e) => e.type).join(",");
    wtTrace("apply", `applyEvents prId=${prId} count=${events.length} types=[${types}]`);
  }
  updateEntry(prId, (entry) => {
    let newBlocks: WalkthroughBlock[] | null = null;

    for (const event of events) {
      switch (event.type) {
        case "summary":
          entry.summary = event.data.summary;
          entry.riskLevel = event.data.riskLevel;
          break;
        case "sentiment":
          entry.sentiment = event.data.sentiment;
          break;
        case "semantic-step": {
          const idx = entry.semanticSteps.findIndex(
            (s) => s.semanticStepIndex === event.data.semanticStepIndex,
          );
          if (idx >= 0) {
            entry.semanticSteps = entry.semanticSteps.map((s, i) => (i === idx ? event.data : s));
          } else {
            entry.semanticSteps = [...entry.semanticSteps, event.data].sort(
              (a, b) => a.semanticStepIndex - b.semanticStepIndex,
            );
          }
          break;
        }
        case "block": {
          if (!newBlocks) newBlocks = [...entry.blocks];
          const bi = newBlocks.findIndex((b) => b.id === event.data.id);
          if (bi >= 0) {
            newBlocks[bi] = event.data;
          } else {
            newBlocks.push(event.data);
          }
          break;
        }
        case "done":
          entry.walkthroughId = event.data.walkthroughId;
          entry.doneReceived = true;
          entry.isStreaming = false;
          entry.tokenUsage = coerceTokenUsage(event.data.tokenUsage);
          if (entry.summary !== null && entry.blocks.length > 0 && entry.ratings.length === 9) {
            entry.lastCompletedPhase = "D";
          }
          break;
        case "usage":
          entry.tokenUsage = coerceTokenUsage(event.data.tokenUsage);
          break;
        case "exploration":
          entry.explorationSteps = [...entry.explorationSteps, event.data];
          break;
        case "issue": {
          const ii = entry.issues.findIndex((i) => i.id === event.data.id);
          if (ii >= 0) {
            entry.issues = entry.issues.map((i, x) => (x === ii ? event.data : i));
          } else {
            entry.issues = [...entry.issues, event.data];
          }
          break;
        }
        case "rating": {
          const idx = entry.ratings.findIndex((r) => r.axis === event.data.axis);
          if (idx >= 0) {
            entry.ratings = entry.ratings.map((r, i) => (i === idx ? event.data : r));
          } else {
            entry.ratings = [...entry.ratings, event.data];
          }
          break;
        }
        case "phase":
          entry.phase = event.data.phase;
          entry.phaseMessage = event.data.message;
          if (event.data.phase !== "connecting") {
            entry.liveGeneration = true;
          }
          break;
        case "phase:advanced":
          entry.lastCompletedPhase = event.data.lastCompletedPhase;
          entry.liveGeneration = true;
          break;
        case "error":
          if (event.data.code === "CloneInProgress" && event.data.repoId != null) {
            entry.cloneInProgress = true;
            entry.cloneRepoId = event.data.repoId;
            entry.isStreaming = false;
          } else if (event.data.code === "CloneInProgress") {
            entry.cloneInProgress = false;
            entry.cloneRepoId = null;
            entry.isStreaming = false;
            entry.streamError =
              "Walkthrough could not start: the repository is cloning, but the server did not report which one. Retry to try again.";
          } else {
            entry.streamError = event.data.message;
            entry.isStreaming = false;
          }
          break;
        case "in-progress":
          entry.walkthroughId = event.data.walkthroughId;
          entry.phase = "writing";
          entry.phaseMessage = "Generating walkthrough...";
          entry.liveGeneration = true;
          break;
        case "thinking":
          break;
        case "block:deleted":
          if (!newBlocks) newBlocks = [...entry.blocks];
          newBlocks = newBlocks.filter((b) => b.id !== event.data.id);
          break;
        case "rating:deleted":
          entry.ratings = entry.ratings.filter((r) => r.axis !== event.data.axis);
          break;
        case "issue:deleted":
          entry.issues = entry.issues.filter((i) => i.id !== event.data.id);
          break;
        case "semantic-step:deleted": {
          const idx = event.data.semanticStepIndex;
          entry.semanticSteps = entry.semanticSteps.filter((s) => s.semanticStepIndex !== idx);
          if (!newBlocks) newBlocks = [...entry.blocks];
          newBlocks = newBlocks.filter((b) => b.semanticStepIndex !== idx);
          break;
        }
        // ── Lifecycle events (global SSE bus). Flip
        //    streaming/completion/error/superseded state without touching
        //    content. Each one was previously a standalone WS envelope.
        case "lifecycle:started":
          entry.walkthroughId = event.data.walkthroughId;
          entry.isStreaming = true;
          entry.doneReceived = false;
          entry.streamError = null;
          entry.superseded = false;
          entry.liveGeneration = true;
          entry.phase = "connecting";
          entry.phaseMessage = "Starting walkthrough…";
          if (entry.streamStartedAt === null) entry.streamStartedAt = Date.now();
          if (event.data.status === "cloning" && event.data.repoId) {
            entry.cloneInProgress = true;
            entry.cloneRepoId = event.data.repoId;
            entry.isStreaming = false;
          } else {
            entry.cloneInProgress = false;
            entry.cloneRepoId = null;
          }
          break;
        case "lifecycle:complete":
          entry.walkthroughId = event.data.walkthroughId;
          entry.doneReceived = true;
          entry.isStreaming = false;
          entry.tokenUsage = coerceTokenUsage(event.data.tokenUsage);
          if (entry.summary !== null && entry.blocks.length > 0 && entry.ratings.length === 9) {
            entry.lastCompletedPhase = "D";
          }
          break;
        case "lifecycle:error":
          if (event.data.code === "CloneInProgress" && event.data.repoId) {
            entry.cloneInProgress = true;
            entry.cloneRepoId = event.data.repoId;
            entry.isStreaming = false;
          } else {
            entry.streamError = event.data.message;
            entry.isStreaming = false;
          }
          break;
        case "lifecycle:cache-hit":
          entry.source = "remote";
          entry.walkthroughId = event.data.walkthroughId;
          break;
        case "lifecycle:edited":
          // No state change — the inner block/issue/etc. event lands in the
          // same stream as a separate envelope (with its own seq). This
          // marker is purely diagnostic / future-proofing.
          break;
        case "lifecycle:superseded":
          entry.superseded = true;
          entry.isStreaming = false;
          break;
      }
    }

    if (newBlocks) {
      newBlocks.sort((a, b) => a.order - b.order);
      entry.blocks = newBlocks;
    }
  });
}

// ── Global SSE event entry point ────────────────────────────────────────────

export function onWalkthroughEvent(
  prId: string,
  walkthroughId: string,
  seq: number,
  event: WalkthroughStreamEvent,
): void {
  const cursor = store.lastSeenSeq.get(walkthroughId) ?? -1;
  if (seq <= cursor) {
    wtTrace(
      "apply",
      `onWalkthroughEvent-drop wt=${walkthroughId} seq=${seq} cursor=${cursor} type=${event.type}`,
    );
    return;
  }

  // `lifecycle:started` may be the first signal we get for a PR the user
  // isn't currently viewing (background generation). Seed an entry so the
  // sidebar spinner has something to read.
  if (event.type === "lifecycle:started" && !store.entries.has(prId)) {
    const stub = freshEntry();
    stub.walkthroughId = walkthroughId;
    stub.isStreaming = event.data.status !== "cloning";
    stub.liveGeneration = true;
    stub.phase = "connecting";
    stub.phaseMessage = "Starting walkthrough…";
    if (event.data.status === "cloning" && event.data.repoId) {
      stub.cloneInProgress = true;
      stub.cloneRepoId = event.data.repoId;
      stub.isStreaming = false;
    }
    setEntry(prId, stub);
  }

  applyEvents(prId, [event]);
  store.lastSeenSeq.set(walkthroughId, seq);
  store.lastSeenSeq = new Map(store.lastSeenSeq);

  // Background-completion toast: only if the completion event landed on a
  // PR the user isn't actively viewing.
  if (event.type === "lifecycle:complete" && store.activePrId !== prId) {
    toast.success("Walkthrough ready", {
      description: "Switch to that PR to review.",
    });
  }
}

/**
 * On SSE (re)connect: seed entries for any in-flight walkthroughs owned
 * by the user's account. Drives the sidebar spinner and primes
 * `lastSeenSeq` so subsequent SSE envelopes apply via the same cursor
 * the snapshot already covered.
 */
export async function hydrateActiveWalkthroughs(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/walkthroughs/active`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      walkthroughs: Array<{
        prId: string;
        walkthroughId: string;
        prHeadSha: string;
        seqAt: number;
      }>;
    };
    for (const row of body.walkthroughs) {
      const existing = store.entries.get(row.prId);
      if (!existing) {
        const stub = freshEntry();
        stub.walkthroughId = row.walkthroughId;
        stub.isStreaming = true;
        stub.liveGeneration = true;
        stub.phase = "writing";
        stub.phaseMessage = "Generating walkthrough…";
        setEntry(row.prId, stub);
      }
      store.lastSeenSeq.set(row.walkthroughId, row.seqAt);
    }
    store.lastSeenSeq = new Map(store.lastSeenSeq);
  } catch (e) {
    wtTrace(
      "lifecycle",
      `hydrateActiveWalkthroughs failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Stamp `submittedAt` on the given walkthrough issues so the UI's "already
 * posted to GitHub" treatment renders immediately after a Submit/Approve
 * succeeds.
 */
export function markIssuesAsSubmitted(
  prId: string,
  issueIds: readonly string[],
  submittedAt: string,
): void {
  if (issueIds.length === 0) return;
  const idSet = new Set(issueIds);
  updateEntry(prId, (entry) => {
    entry.issues = entry.issues.map((i) => (idSet.has(i.id) ? { ...i, submittedAt } : i));
  });
}

// ── Pre-mount setup ─────────────────────────────────────────────────────────

/**
 * Synchronously mark a PR as active and seed a "loading" entry if one
 * doesn't already exist. Runs on component mount before the hydration
 * fetch resolves, so the UI renders the skeleton immediately instead of
 * briefly flashing the empty state.
 */
export function prepareEntry(prId: string): void {
  store.activePrId = prId;
  const existing = store.entries.get(prId);
  if (
    existing &&
    existing.summary !== null &&
    existing.blocks.length > 0 &&
    existing.doneReceived &&
    !existing.streamError
  ) {
    return;
  }
  if (existing) return;
  setEntry(prId, {
    ...freshEntry(),
    isStreaming: false,
    phaseMessage: "",
    streamStartedAt: null,
  });
}

/**
 * Mark the active PR as deselected. With the global SSE bus there is no
 * per-PR subscription to close — generation continues in the background
 * and events still arrive for the entry, which is exactly what we want
 * when navigating between PRs.
 */
export function deactivate(): void {
  store.activePrId = null;
}

export function reset(): void {
  const activePrId = store.activePrId;
  if (activePrId) {
    deleteEntry(activePrId);
    store.activePrId = null;
  }
}

// ── Cache hydration ─────────────────────────────────────────────────────────

const pendingHydration = new Map<string, Promise<boolean>>();

/**
 * Read current walkthrough state for `prId` and reconcile it into the
 * reactive store. The only client path that returns walkthrough content
 * without potentially triggering generation. Called from
 * `GuidedWalkthrough.onMount` to render instantly on cache hit; live
 * progress for an in-flight job arrives via the global SSE bus.
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
        avatarUrl: string | null;
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
          seqAt?: number;
        };

    if (body.status === "not_found") {
      wtTrace("lifecycle", `hydrateFromCache prId=${prId} status=not_found → false`);
      return false;
    }

    const wt = body.walkthrough;
    const { status } = body;
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
    entry.generatedBy = wt.generatedBy ?? entry.generatedBy ?? null;
    entry.providerConfig = wt.providerConfig ?? entry.providerConfig ?? null;
    if (previous?.source === "remote") entry.source = "remote";
    if (isGenerating) entry.streamStartedAt = Date.now();
    setEntry(prId, entry);

    // Seed the seq cursor so subsequent SSE envelopes covered by this snapshot
    // are dropped as defensive duplicates. `seqAt` is the most recent seq the
    // server stamped before composing the snapshot; future envelopes have
    // higher seqs and apply normally.
    if (typeof body.seqAt === "number") {
      store.lastSeenSeq.set(wt.id, body.seqAt);
      store.lastSeenSeq = new Map(store.lastSeenSeq);
    }

    if (options?.activate !== false) {
      store.activePrId = prId;
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

// ── Clone polling ───────────────────────────────────────────────────────────

const clonePollers = new Map<string, { cancelled: boolean }>();
const CLONE_POLL_INTERVAL_MS = 2000;
const CLONE_POLL_MAX_MS = 10 * 60 * 1000;

export function stopClonePoll(prId: string): void {
  const p = clonePollers.get(prId);
  if (p) p.cancelled = true;
  clonePollers.delete(prId);
}

export async function pollCloneUntilResolved(prId: string, repoId: string): Promise<void> {
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
        // Clone finished — kick off generation; server will broadcast
        // `lifecycle:started` and content events via the global SSE bus.
        void startWalkthrough(prId);
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

// ── User-driven actions (REST → server broadcasts via SSE bus) ──────────────

/**
 * Trigger fresh walkthrough generation for `prId`. The server is
 * idempotent — if a job is already running for this PR's head SHA it
 * returns the existing walkthroughId instead of starting a new one.
 */
export async function startWalkthrough(prId: string): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/start`, {
      method: "POST",
      headers: authHeaders(),
    });
  } catch (e) {
    wtTrace(
      "lifecycle",
      `startWalkthrough prId=${prId} error=${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Local-only stop. With the global SSE bus there is no per-PR
 * subscription to cancel and no server-side stop endpoint — we mark
 * the entry as no-longer-streaming. Server-side generation continues
 * in the background; any subsequent content events still apply via the
 * reducer but won't flip `isStreaming` back on (only `lifecycle:started`
 * does, which is what we want for explicit resumes).
 */
export function abort(prId: string): void {
  updateEntry(prId, (e) => {
    e.isStreaming = false;
    e.streamError = null;
  });
  stopClonePoll(prId);
}

export async function regenerate(prId: string): Promise<void> {
  if (pendingActions.map.has(prId)) return;
  setPending(prId, "regenerate");
  try {
    clearAnimationTrackers(prId);
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
      // Non-fatal — the start call below will still create a fresh job.
    }

    // Drop the stale freshEntry so the server's `lifecycle:started`
    // emission re-seeds the entry with the new walkthroughId.
    deleteEntry(prId);

    await startWalkthrough(prId);
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
      // best-effort
    }
  } finally {
    clearPending(prId);
  }
}

/**
 * Called when a new commit pulled in for the PR invalidates the
 * existing walkthrough. Marks the rows superseded server-side without
 * starting a fresh job — the user opts in to regenerate explicitly via
 * the Generate button.
 */
export async function invalidateForPull(prId: string): Promise<void> {
  clearAnimationTrackers(prId);
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

// ── Animated block tracking ─────────────────────────────────────────────────
//
// Non-reactive — tracks which block/issue/container IDs have already animated,
// keyed by PR ID. Lives outside `entries` so it survives component remounts.
// Cleared on regenerate/invalidateForPull via clearAnimationTrackers().

const animatedBlocks = new Map<string, Set<string>>();
const animatedIssues = new Map<string, Set<string>>();
const animatedContainers = new Map<string, Set<string>>();

export function clearAnimationTrackers(prId: string): void {
  animatedBlocks.delete(prId);
  animatedIssues.delete(prId);
  animatedContainers.delete(prId);
}

export function hasBlockAnimated(prId: string, blockId: string): boolean {
  return animatedBlocks.get(prId)?.has(blockId) ?? false;
}
export function markBlockAnimated(prId: string, blockId: string): void {
  let set = animatedBlocks.get(prId);
  if (!set) {
    set = new Set();
    animatedBlocks.set(prId, set);
  }
  set.add(blockId);
}

export function hasIssueAnimated(prId: string, issueId: string): boolean {
  return animatedIssues.get(prId)?.has(issueId) ?? false;
}
export function markIssueAnimated(prId: string, issueId: string): void {
  let set = animatedIssues.get(prId);
  if (!set) {
    set = new Set();
    animatedIssues.set(prId, set);
  }
  set.add(issueId);
}

export function hasContainerAnimated(prId: string, key: string): boolean {
  return animatedContainers.get(prId)?.has(key) ?? false;
}
export function markContainerAnimated(prId: string, key: string): void {
  let set = animatedContainers.get(prId);
  if (!set) {
    set = new Set();
    animatedContainers.set(prId, set);
  }
  set.add(key);
}
