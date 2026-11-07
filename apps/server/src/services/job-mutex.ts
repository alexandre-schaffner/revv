// Per-key serialization for a job orchestrator's check-and-launch paths.
// Without it, two concurrent starts for the same key can both pass an in-memory liveness
// check and both fork a daemon fiber, orphaning a semaphore permit that no
// `cancel` can ever reach. Ephemeral coordination (invariant 1): the map is
// rebuilt from scratch on restart.

import { Effect, Ref, Semaphore } from "effect";

export interface StartJobMutex {
  /** Callers serialize their critical section with `mutex.withPermits(1)(body)`. */
  readonly acquire: (key: string) => Effect.Effect<Semaphore.Semaphore>;
}

export const makeStartJobMutex = (): Effect.Effect<StartJobMutex> =>
  Effect.gen(function* () {
    const mutexes = yield* Ref.make(new Map<string, Semaphore.Semaphore>());

    const acquire = (key: string): Effect.Effect<Semaphore.Semaphore> =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(mutexes)).get(key);
        if (cached) return cached;
        const candidate = yield* Semaphore.make(1);
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
