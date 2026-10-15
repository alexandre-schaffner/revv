// ── In-flight background judgments ───────────────────────────────────────────
// Phase B's Jev hooks are fire-and-forget: `flag_issue` writes the row and returns,
// and the relevance judgment lands later, possibly retracting it. This closes two
// holes that opens:
//
//   1. `complete_walkthrough` would validate an issue set still in flux. The gate
//      awaits this registry first, so every judgment has landed before it counts.
//   2. `add_issue_comment` could reference an issue a judgment just deleted. The
//      retracted set turns that into an explanatory non-error, not "unknown issue".
//
// Ephemeral and safe to lose: a `kill -9` drops both maps, leaving an issue
// unjudged — the same state as Jev switched off. Doesn't belong in SQLite
// (invariant 1).

import { debug } from "../../logger";

/** Work started for a walkthrough and not yet settled. */
const inFlight = new Map<string, Set<Promise<unknown>>>();

/** Issue ids a judgment has deleted, per walkthrough. */
const retracted = new Map<string, Set<string>>();

/** Registers background work and swallows its failure; tracked, not awaited, so the caller returns immediately. A crashed judgment must never take down the tool call that scheduled it. */
export function trackJudgment(walkthroughId: string, work: Promise<unknown>): void {
  const settled = work.catch((err: unknown) => {
    debug(
      "jev",
      `background judgment failed for ${walkthroughId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const set = inFlight.get(walkthroughId) ?? new Set();
  set.add(settled);
  inFlight.set(walkthroughId, set);
  void settled.finally(() => {
    set.delete(settled);
    if (set.size === 0) inFlight.delete(walkthroughId);
  });
}

/** How many judgments are still outstanding. Diagnostics only. */
export function pendingCount(walkthroughId: string): number {
  return inFlight.get(walkthroughId)?.size ?? 0;
}

/** Drains every judgment for this walkthrough. Loops rather than snapshotting once, since new judgments can be scheduled mid-drain. Bounded: exceeding the round cap lets the gate proceed anyway, degrading to "judged late" rather than wedging. */
export async function awaitJudgments(walkthroughId: string, maxRounds = 10): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const set = inFlight.get(walkthroughId);
    if (!set || set.size === 0) return;
    await Promise.allSettled([...set]);
  }
  debug(
    "jev",
    `drain for ${walkthroughId} hit the round cap with ${pendingCount(walkthroughId)} still in flight`,
  );
}

export function markRetracted(walkthroughId: string, issueId: string): void {
  const set = retracted.get(walkthroughId) ?? new Set();
  set.add(issueId);
  retracted.set(walkthroughId, set);
}

export function wasRetracted(walkthroughId: string, issueId: string): boolean {
  return retracted.get(walkthroughId)?.has(issueId) === true;
}

/** Drop both maps for a finished job. Called on every job exit path. */
export function forgetWalkthrough(walkthroughId: string): void {
  inFlight.delete(walkthroughId);
  retracted.delete(walkthroughId);
}
