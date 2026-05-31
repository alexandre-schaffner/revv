// ── Start-job mutex ────────────────────────────────────────────────────────
//
// Per-key serialization for a job orchestrator's `startJob` path. Without it,
// two concurrent starts for the same key can both pass an in-memory liveness
// check and both fork a daemon fiber — orphaning a semaphore permit that no
// `cancel` can ever reach (see WalkthroughJobs' `startJobMutexes` rationale).
//
// Each distinct key gets its own capacity-1 semaphore, created lazily and
// installed atomically via `Ref.modify` so a race to create the same key's
// mutex still yields a single shared semaphore. This is ephemeral coordination
// (CLAUDE.md invariant #1): the map is rebuilt from scratch on restart.

import { Effect, Ref } from "effect";

export interface StartJobMutex {
  /**
   * Resolve (creating on first use) the capacity-1 semaphore guarding `key`.
   * Callers serialize their critical section with `mutex.withPermits(1)(body)`.
   */
  readonly acquire: (key: string) => Effect.Effect<Effect.Semaphore>;
}

export const makeStartJobMutex = (): Effect.Effect<StartJobMutex> =>
  Effect.gen(function* () {
    const mutexes = yield* Ref.make(new Map<string, Effect.Semaphore>());

    const acquire = (key: string): Effect.Effect<Effect.Semaphore> =>
      Effect.gen(function* () {
        // Fast path: a mutex for this key already exists.
        const cached = (yield* Ref.get(mutexes)).get(key);
        if (cached) return cached;
        // Slow path: build a candidate, then atomically install it
        // or yield to the racing winner inside `Ref.modify`.
        const candidate = yield* Effect.makeSemaphore(1);
        return yield* Ref.modify(mutexes, (map) => {
          const winner = map.get(key);
          if (winner) return [winner, map];
          const next = new Map(map);
          next.set(key, candidate);
          return [candidate, next];
        });
      });

    return { acquire };
  });
