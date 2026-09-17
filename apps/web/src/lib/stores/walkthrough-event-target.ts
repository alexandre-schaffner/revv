// ── Walkthrough event addressing ────────────────────────────────────────────
//
// Plain module (no runes) so it can be unit-tested, same as
// `walkthrough-entry-equal.ts`. Answers one question for the global SSE
// reducer: is this `walkthrough:event` envelope about the walkthrough the PR's
// store entry is currently following?
//
// The question exists because the store keeps ONE entry per PR while the server
// keeps a walkthrough row per (head SHA, mode, generation mode). A PR therefore
// has several walkthroughs over its life, and every one of their envelopes
// arrives on the same account-wide stream tagged with the same `prId`.
// Regenerating deletes the entry and seeds a fresh one, so a previous row's
// terminal envelope — typically the `lifecycle:superseded` the server emits
// when its supersede sweep cancels an older job — can land *after* the new
// generation started and flip the fresh entry to "outdated, not streaming",
// which renders as "No walkthrough generated yet for this PR" plus the
// outdated-walkthrough toast while the new job is in fact running fine.

import type { WalkthroughStreamEvent } from "@revv/shared";

/**
 * Lifecycle envelopes that flip an entry out of its streaming state. Applied
 * from the wrong walkthrough these don't merely add noise, they tear the view
 * down — `lifecycle:superseded` alone sets `superseded` and clears
 * `isStreaming`.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<WalkthroughStreamEvent["type"]> = new Set([
  "done",
  "lifecycle:complete",
  "lifecycle:error",
  "lifecycle:superseded",
]);

/** The parts of a `WalkthroughEntry` that decide event addressing. */
export interface EventTargetEntry {
  readonly walkthroughId: string | null;
  readonly isStreaming: boolean;
  readonly liveGeneration: boolean;
}

/**
 * `true` when `event` may be applied to `entry`.
 *
 * `lifecycle:started` is the envelope through which an entry learns which
 * walkthrough to follow, so callers must always let it through — it is not
 * routed here.
 */
export function addressesActiveWalkthrough(
  entry: EventTargetEntry,
  walkthroughId: string,
  eventType: WalkthroughStreamEvent["type"],
): boolean {
  if (entry.walkthroughId !== null) return entry.walkthroughId === walkthroughId;
  // No id yet, so we can't compare. Two ways to get here:
  //
  //   • a mount-time seed still waiting on its hydration fetch (not streaming)
  //     — take the events, they're the only content we have;
  //   • a generation we just requested whose `lifecycle:started` hasn't arrived
  //     (streaming) — content events can only be ours, but a terminal envelope
  //     is necessarily some earlier job's, because ours cannot finish before it
  //     has started.
  if (!entry.isStreaming && !entry.liveGeneration) return true;
  return !TERMINAL_EVENT_TYPES.has(eventType);
}
