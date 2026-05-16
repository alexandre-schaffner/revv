import { Effect } from "effect";
import type { Db } from "../db/index";
import { ReviewError } from "../domain/errors";
import { DbService } from "../services/Db";

/**
 * Wrap a synchronous Drizzle call in an Effect that fails with a tagged
 * {@link ReviewError} instead of a raw thrown exception. Centralizes the
 * repetitive `Effect.try({ try, catch })` blocks across services into
 * a single one-liner.
 *
 * @example
 * ```ts
 * yield* tryDb('insert thread', (db) => db.insert(commentThreads).values(row).run());
 * ```
 *
 * The `label` becomes the message prefix on failure.
 */
export const tryDb = <A>(
  label: string,
  run: (db: Db) => A,
): Effect.Effect<A, ReviewError, DbService> =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    return yield* Effect.try({
      try: () => run(db),
      catch: (e) => new ReviewError({ message: `Failed to ${label}: ${String(e)}` }),
    });
  });
