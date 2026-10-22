// ── Poll while pending ──────────────────────────────────────────────────────
//
// Shared by the stores whose endpoint answers `pending` until the PR's diff is
// cached (sizing preview, first pass). The diff-cache fill has no client-visible
// event, so they re-ask on a timer; bounded, so a diff that never caches
// settles instead of polling forever. Plain module (no runes): the reactive
// state lives in the store that owns the answer.

/** One ask's outcome: `pending` re-asks after a delay, `done` stops (answer, or a real error). */
export type PollAnswer = "pending" | "done";

interface PendingPollOptions {
  maxRetries?: number;
  retryMs?: number;
  /** Called once for a key whose retry budget ran out while still pending. */
  onGiveUp?: (key: string) => void;
}

export interface PendingPoll {
  /**
   * Ask via `fetcher`, de-duped per key: a call while one is in flight joins
   * it. A `pending` answer re-runs `fetcher` after a delay, up to the budget.
   * `fetcher` records its own answers and errors; a throw ends the poll.
   */
  pollWhilePending(key: string, fetcher: () => Promise<PollAnswer>): Promise<void>;
  /** The key answered `pending` until the budget ran out. */
  gaveUp(key: string): boolean;
  /** Forget every key; retries already scheduled become no-ops. */
  reset(): void;
}

export function createPendingPoll({
  maxRetries = 6,
  retryMs = 2_500,
  onGiveUp,
}: PendingPollOptions = {}): PendingPoll {
  const inFlight = new Map<string, Promise<void>>();
  const attempts = new Map<string, number>();
  let generation = 0;

  function pollWhilePending(key: string, fetcher: () => Promise<PollAnswer>): Promise<void> {
    const running = inFlight.get(key);
    if (running) return running;
    const gen = generation;
    const task = (async () => {
      try {
        const answer = await fetcher();
        // A reset while this was in flight wiped the key; don't write it back.
        if (gen !== generation) return;
        if (answer === "done") {
          attempts.delete(key);
          return;
        }
        const tried = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, tried);
        if (tried >= maxRetries) {
          onGiveUp?.(key);
          return;
        }
        setTimeout(() => {
          if (gen === generation) void pollWhilePending(key, fetcher);
        }, retryMs);
      } catch {
        // The fetcher owns its error handling; a throw just stops the poll.
      } finally {
        // After a reset the key may hold a newer ask; leave that one be.
        if (gen === generation) inFlight.delete(key);
      }
    })();
    inFlight.set(key, task);
    return task;
  }

  return {
    pollWhilePending,
    gaveUp: (key) => (attempts.get(key) ?? 0) >= maxRetries,
    reset() {
      generation += 1;
      inFlight.clear();
      attempts.clear();
    },
  };
}
