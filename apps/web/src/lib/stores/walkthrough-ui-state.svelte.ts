// ── Walkthrough UI state projection ─────────────────────────────────────────
//
// Single source of truth for which floating-action-bar buttons the active
// PR's walkthrough should display. The bar previously branched on five
// separate $derived booleans (isStreaming, canResume, streamError, summary,
// hasRatings) — that cascade leaked subtle inconsistencies, most visibly:
//   * a normally-completed stream landing in `resumable` until hydration
//     fixed lastCompletedPhase on tab-switch;
//   * superseded walkthroughs being indistinguishable from healthy ones.
//
// This module reads the same entry through `getActiveEntry()` (which goes
// through the `_active` $derived in walkthrough.svelte.ts — see the comment
// there for why a plain function would break cross-module reactivity) and
// projects it onto a single discriminated union. The floating bar switches
// on `kind` and nothing else.

import type { WalkthroughLifecyclePhase, WalkthroughPipelinePhase } from "@revv/shared";
import { getActiveEntry } from "./walkthrough.svelte";

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

const uiState: WalkthroughUiState = $derived.by(() => {
  const e = getActiveEntry();
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
  return uiState;
}
