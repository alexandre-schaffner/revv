import { Effect } from "effect";
import type { JevUnavailable } from "../../domain/errors";
import { debug } from "../../logger";
import { CacheService, type CacheSetOptions } from "../../services/Cache";
import type { DbService } from "../../services/Db";
import { JevService } from "../../services/Jev";

/** Collapse an optional Jev judgment into `null`, with one consistent log. */
export function optionalJev<A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | null, never, R> {
  return effect.pipe(
    Effect.match({
      onFailure: (error) => {
        debug("jev", `${label} unavailable (${String(error)}) — using agent judgment`);
        return null;
      },
      onSuccess: (value) => value,
    }),
  );
}

/**
 * A Jev judgment memoized in the cache, or `null` when Jev is off or can't
 * answer. Jev's switch is checked before the cache: a judgment cached while
 * it was on is not one to act on once it is off.
 */
export function cachedJev<A>(
  label: string,
  key: { readonly ns: string; readonly key: string; readonly options: CacheSetOptions },
  judge: () => Effect.Effect<A, JevUnavailable, JevService>,
): Effect.Effect<A | null, never, JevService | CacheService | DbService> {
  return Effect.gen(function* () {
    const jev = yield* JevService;
    if (!(yield* jev.isAvailable())) return null;
    const cache = yield* CacheService;
    return yield* optionalJev(label, cache.getOrFetch(key.ns, key.key, judge, key.options));
  });
}
