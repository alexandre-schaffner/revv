// The store keeps one entry per PR while the server keeps a walkthrough row
// per (head SHA, mode, generation mode), and every row's envelopes arrive on
// the account-wide stream tagged with the same `prId`. A previous row's
// terminal envelope (typically the `lifecycle:superseded` the server's
// supersede sweep emits) can land after a regenerate seeded a fresh entry, and
// must not flip that entry to "outdated, not streaming" while the new job runs.

import type { WalkthroughStreamEvent } from "@revv/shared";

const TERMINAL_EVENT_TYPES: ReadonlySet<WalkthroughStreamEvent["type"]> = new Set([
  "lifecycle:complete",
  "lifecycle:error",
  "lifecycle:superseded",
]);

export interface EventTargetEntry {
  readonly walkthroughId: string | null;
  readonly isStreaming: boolean;
  readonly liveGeneration: boolean;
}

/**
 * `lifecycle:started` is how an entry learns which walkthrough to follow, so
 * callers must always let it through without asking here.
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
