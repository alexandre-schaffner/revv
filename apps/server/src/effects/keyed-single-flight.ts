import { Deferred, Effect } from "effect";

export const keyedSingleFlight = <K, A, E>() => {
  const inFlight = new Map<K, Deferred.Deferred<A, E>>();
  return <R>(key: K, run: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Deferred.make<A, E>(), (own) =>
      Effect.suspend(() => {
        const leader = inFlight.get(key);
        if (leader !== undefined) return Deferred.await(leader);
        inFlight.set(key, own);
        return run.pipe(
          Effect.onExit((exit) =>
            Effect.andThen(
              Effect.sync(() => inFlight.delete(key)),
              Deferred.done(own, exit),
            ),
          ),
        );
      }),
    );
};
