import { Deferred, Effect } from "effect";

/**
 * One run per key at a time: a caller arriving while a run for its key is in
 * flight joins that run and gets its outcome — success, failure or
 * interruption — instead of starting a second one. The slot frees as soon as
 * the run ends, so the next caller starts afresh.
 *
 * In-memory and per process, like any coordination cache: losing it costs one
 * duplicate run.
 */
export const keyedSingleFlight = <K, A, E>() => {
  const inFlight = new Map<K, Deferred.Deferred<A, E>>();
  return <R>(key: K, run: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Deferred.make<A, E>(), (own) =>
      // Claim-or-join happens in one synchronous step, so two callers can
      // never both become the leader.
      Effect.suspend(() => {
        const leader = inFlight.get(key);
        if (leader !== undefined) return Deferred.await(leader);
        inFlight.set(key, own);
        return run.pipe(
          Effect.onExit((exit) =>
            Effect.zipRight(
              Effect.sync(() => inFlight.delete(key)),
              Deferred.done(own, exit),
            ),
          ),
        );
      }),
    );
};
