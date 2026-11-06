import { Effect } from "effect";
import type { Db } from "../db/index";
import { DbError } from "../domain/errors";
import { DbService } from "../services/Db";

/**
 * Run a synchronous Drizzle call, failing with a tagged {@link DbError}
 * instead of throwing. The `label` becomes the message prefix on failure.
 *
 * @example
 * ```ts
 * yield* tryDb('insert thread', (db) => db.insert(commentThreads).values(row).run());
 * ```
 */
export const tryDb = <A>(label: string, run: (db: Db) => A): Effect.Effect<A, DbError, DbService> =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    return yield* Effect.try({
      try: () => run(db),
      catch: (cause) => new DbError({ message: `Failed to ${label}: ${String(cause)}`, cause }),
    });
  });
