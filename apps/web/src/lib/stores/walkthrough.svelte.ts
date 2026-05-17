// ── Walkthrough state layer ─────────────────────────────────────────────────
//
// Owns the reactive state, all read-access getters, the event-application
// reducer, and the WS mutation handlers whose paths are purely state writes.
// Transport concerns (SSE streaming, hydration, abort, clone polling) live in
// walkthrough-stream.svelte.ts which imports from here — never the reverse.

import type {
  Activity,
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
import { wtTrace } from "$lib/utils/wt-trace";

// ── Entry shape ─────────────────────────────────────────────────────────────

export interface WalkthroughEntry {
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
   * completes.
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
   * landed mid-generation and a fresher walkthrough has been created.
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
   * Cumulative token usage for this PR's walkthrough generation.
   */
  tokenUsage: WalkthroughTokenUsage;
}

export const ZERO_TOKEN_USAGE: WalkthroughTokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});

/**
 * Coerce an unknown payload into a fully-populated WalkthroughTokenUsage with
 * every field defaulting to 0.
 */
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
  };
}

// ── Reactive state ──────────────────────────────────────────────────────────
//
// All reactive state lives on this single `store` object. Other modules
// (notably walkthrough-stream.svelte.ts) read and mutate `store.entries` /
// `store.activePrId` directly — Svelte 5's deep-reactivity proxy intercepts
// both property reads (for dependency tracking) and property writes (for
// invalidation), so cross-module access works without setter wrappers.
//
// Mutation idiom: when adding/removing entries you MUST reassign
// `store.entries = new Map(store.entries)` after the `.set()` / `.delete()`
// call. This Svelte 5 version does NOT track raw Map mutations as reactive
// invalidations (verified: every Map-typed $state in this codebase follows
// the same idiom — see review.svelte.ts, chat.svelte.ts). The `setEntry`,
// `deleteEntry`, and `updateEntry` helpers below encapsulate this.

export const store = $state({
  entries: new Map<string, WalkthroughEntry>(),
  activePrId: null as string | null,
});

// `_active` is the single reactive derivation that resolves the current PR's
// walkthrough entry. Every exported getter reads through it, which means
// any `$derived` in a component that calls a getter inherits a dependency
// on `_active` via Svelte's reactive graph — no manual version counter needed.
//
// Do NOT "simplify" this back to a plain `function active() { ... }`. Svelte 5's
// dependency tracking through a plain function → Map.get() across module
// boundaries silently kept a stale cached result, manifesting as floating
// action buttons stuck on "Stop" until a tab switch forced the $derived to
// re-evaluate. The $derived form turns it into a proper signal node that
// Svelte always invalidates when `store.entries` or `store.activePrId` change.
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

/**
 * Resolve the active PR's walkthrough entry, or undefined if no entry exists.
 * Reads through the `_active` $derived signal so cross-module callers
 * (notably walkthrough-ui-state.svelte.ts) inherit the same reactive
 * dependency tree as in-module getters. See the comment on `_active` above
 * for why a plain function wrapper would break reactivity.
 */
export function getActiveEntry(): WalkthroughEntry | undefined {
  return _active;
}

export function getBlocks(): WalkthroughBlock[] {
  return _active?.blocks ?? [];
}
/**
 * Phase B chapter manifest. Empty until the agent opens the first chapter
 * via `add_semantic_step`.
 */
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
/** Phase C markdown — the "Overall Sentiment" paragraph. */
export function getSentiment(): string | null {
  return _active?.sentiment ?? null;
}
/** Current pointer into the A→B→C→D content pipeline. */
export function getLastCompletedPhase(): WalkthroughPipelinePhase {
  return _active?.lastCompletedPhase ?? "none";
}
/**
 * True when this walkthrough was marked `superseded` by the server.
 */
export function getIsSuperseded(): boolean {
  return _active?.superseded ?? false;
}
/**
 * Cumulative token usage for the active (or specified) PR's walkthrough.
 */
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

/**
 * Returns the prIds of all entries currently in an unresolved streaming state.
 * Used by the WS reconnect handler to reconcile walkthroughs that may have
 * completed while the WS was down.
 */
export function getUnresolvedStreamingPrIds(): string[] {
  const result: string[] = [];
  for (const [prId, entry] of store.entries) {
    if (entry.isStreaming && !entry.doneReceived && !entry.streamError) {
      result.push(prId);
    }
  }
  return result;
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
          // Promote to phase D when the content shows full pipeline completion.
          // The phase-tracking events stop at C in the common case (the final
          // rate_axis call closes Phase D server-side but the agent often
          // doesn't emit a trailing phase:advanced before `done`). Without
          // this, getWalkthroughUiState() would classify a complete stream
          // as resumable until the next hydration. Mirrors the hydration
          // fallback in walkthrough-stream.svelte.ts (`?? "D"`) and the
          // local-mark gate in onWalkthroughComplete().
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
          // Heartbeat — model is active but hasn't produced content yet.
          break;
        // ── Chat-edit deletion events (CLAUDE.md invariant #7 carve-out).
        // Arrive only via the `walkthrough:edited` WS envelope after a
        // walkthrough has completed; the generation SSE path never emits them.
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
      }
    }

    if (newBlocks) {
      // Sort by canonical `order` (semanticStepIndex*10000 + stepIndex) so a
      // chat-edit `add_block` with an explicit middle `step_index` lands in
      // its true position rather than at the end of the array. Live
      // generation already emits in order, so this is a no-op for streams —
      // it only matters for the post-completion chat-edit carve-out
      // (invariant #7), where blocks can arrive out of step_index order.
      newBlocks.sort((a, b) => a.order - b.order);
      entry.blocks = newBlocks;
    }
  });
}

// ── WS-driven updates (state-only paths) ────────────────────────────────────
//
// onWalkthroughComplete lives in walkthrough-stream.svelte.ts because its
// "not content complete" path calls fetchCachedWalkthrough → streamWalkthrough.

export function onWalkthroughError(prId: string, message: string): void {
  const entry = store.entries.get(prId);
  if (entry) {
    updateEntry(prId, (e) => {
      e.isStreaming = false;
      e.streamError = message;
    });
  }
}

/**
 * Apply a chat-driven post-completion edit broadcast (CLAUDE.md invariant #7
 * carve-out). Routes through the same reducer the generation SSE path uses.
 *
 * Drops the event when no entry exists (user hasn't loaded the PR) or the
 * walkthroughId doesn't match (stale broadcast for a superseded walkthrough).
 */
export function onWalkthroughEdited(
  prId: string,
  walkthroughId: string,
  event: WalkthroughStreamEvent,
): void {
  const entry = store.entries.get(prId);
  if (!entry) return;
  if (entry.walkthroughId && entry.walkthroughId !== walkthroughId) return;
  applyEvents(prId, [event]);
}

/**
 * Stamp `submittedAt` on the given walkthrough issues so the UI's "already
 * posted to GitHub" treatment renders immediately after a Submit/Approve succeeds.
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

// ── Animated block tracking ─────────────────────────────────────────────────
//
// Non-reactive — tracks which block/issue/container IDs have already animated,
// keyed by PR ID. Lives outside `entries` so it survives component remounts.
// Cleared on regenerate/invalidateForPull via clearAnimationTrackers().

const animatedBlocks = new Map<string, Set<string>>();
const animatedIssues = new Map<string, Set<string>>();
const animatedContainers = new Map<string, Set<string>>();

/** Clear all animation state for a PR (called on regenerate/invalidateForPull). */
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
