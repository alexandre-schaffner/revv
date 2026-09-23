// ── In-flight background judgments ───────────────────────────────────────────
//
// Phase B's Jev hooks are fire-and-forget: `flag_issue` writes the row and
// returns, and the relevance judgment lands a second or two later, possibly
// retracting it. That keeps the agent moving — but it opens two holes this
// module closes.
//
//   1. **The completion gate could outrun the judgments.** `complete_
//      walkthrough` validates the issue set; if a judgment were still in
//      flight it would validate a set about to change. The gate awaits this
//      registry first, so by the time it counts issues, every judgment the
//      run started has landed.
//   2. **`add_issue_comment` could reference a retracted issue.** The agent is
//      told an issue id, then the judgment deletes the row underneath it. A
//      bare "unknown issue id" would read as the agent's mistake. The
//      retracted set turns it into an explanatory non-error.
//
// **Ephemeral by design, and safe to lose.** A `kill -9` drops both maps; the
// consequence is an issue that never got judged, which is exactly the state a
// walkthrough generated with Jev switched off is in. Nothing here affects
// correctness on resume, so it doesn't belong in SQLite (invariant 1).

import { debug } from "../../logger";

/** Work started for a walkthrough and not yet settled. */
const inFlight = new Map<string, Set<Promise<unknown>>>();

/** Issue ids a judgment has deleted, per walkthrough. */
const retracted = new Map<string, Set<string>>();

/**
 * Register background work and swallow its failure.
 *
 * The promise is tracked, not awaited — the caller returns immediately. A
 * rejection is logged and dropped: a judgment that crashes must never take
 * down the tool call that scheduled it, and an unjudged issue is a valid
 * outcome.
 */
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

/**
 * Drain every judgment started for this walkthrough.
 *
 * Loops rather than awaiting one snapshot: a judgment can be scheduled while
 * an earlier batch is settling (the agent keeps calling tools during the
 * drain). Bounded so a pathological scheduler can't hold the gate open —
 * exceeding the bound leaves the remaining work running and lets the gate
 * proceed, which degrades to "one issue judged late", never a wedge.
 */
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
