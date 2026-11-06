// ── In-flight background judgments ───────────────────────────────────────────
// Phase B's Jev hooks are fire-and-forget: `flag_issue` writes the row and returns,
// and the relevance judgment lands later, possibly retracting it. This closes two
// holes that opens:
//
//   1. `complete_walkthrough` would validate an issue set still in flux. The gate
//      awaits this tracker first, so every judgment has landed before it counts.
//   2. `add_issue_comment` could reference an issue a judgment just deleted. The
//      retracted set turns that into an explanatory non-error, not "unknown issue".
//
// One tracker per walkthrough run, dropped with the run. Losing it (a `kill -9`)
// leaves an issue unjudged — the same state as Jev switched off. Doesn't belong
// in SQLite (invariant 1).

import { debug } from "../../logger";

export interface JudgmentTracker {
  /** Registers background work and swallows its failure; tracked, not awaited, so the caller returns immediately. A crashed judgment must never take down the tool call that scheduled it. */
  readonly track: (work: Promise<unknown>) => void;
  /** Drains every judgment, including ones scheduled mid-drain. Bounded: past the round cap the gate proceeds, degrading to "judged late" rather than wedging. */
  readonly drain: (maxRounds?: number) => Promise<void>;
  /** How many judgments are still outstanding. Diagnostics only. */
  readonly pending: () => number;
  readonly markRetracted: (issueId: string) => void;
  readonly wasRetracted: (issueId: string) => boolean;
}

export function makeJudgmentTracker(walkthroughId: string): JudgmentTracker {
  const inFlight = new Set<Promise<unknown>>();
  const retracted = new Set<string>();

  return {
    track: (work) => {
      const settled = work.catch((err: unknown) => {
        debug(
          "jev",
          `background judgment failed for ${walkthroughId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      inFlight.add(settled);
      void settled.finally(() => inFlight.delete(settled));
    },
    drain: async (maxRounds = 10) => {
      for (let round = 0; round < maxRounds; round++) {
        if (inFlight.size === 0) return;
        await Promise.allSettled([...inFlight]);
      }
      debug(
        "jev",
        `drain for ${walkthroughId} hit the round cap with ${inFlight.size} still in flight`,
      );
    },
    pending: () => inFlight.size,
    markRetracted: (issueId) => {
      retracted.add(issueId);
    },
    wasRetracted: (issueId) => retracted.has(issueId),
  };
}
