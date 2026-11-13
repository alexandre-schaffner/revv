import { Deferred, Effect } from "effect";

export interface SingleFlightOptions {
  /**
   * Run the work on its own fiber, so an interrupted leader leaves it running
   * and a later caller joins it rather than starting a second one.
   */
  readonly detach?: boolean;
  /** Called each time a caller joins work already in flight. */
  readonly onJoin?: () => void;
}

/**
 * One run of `work` per key at a time: a call while one is in flight for the
 * same key joins it, and every caller sees its result, typed failure
 * included. Settling drops the entry, so a failure is never replayed.
 */
export const keyedSingleFlight = <K, A, E>(options: SingleFlightOptions = {}) => {
  const inFlight = new Map<K, Deferred.Deferred<A, E>>();
  return <R>(key: K, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Deferred.make<A, E>(), (own) =>
      Effect.suspend(() => {
        const leader = inFlight.get(key);
        if (leader !== undefined) {
          options.onJoin?.();
          return Deferred.await(leader);
        }
        inFlight.set(key, own);
        const settled = work.pipe(
          Effect.onExit((exit) =>
            Effect.andThen(
              Effect.sync(() => inFlight.delete(key)),
              Deferred.done(own, exit),
            ),
          ),
        );
        return options.detach
          ? Effect.andThen(Effect.forkDetach(settled), Deferred.await(own))
          : settled;
      }),
    );
};
