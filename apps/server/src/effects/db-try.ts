import { Effect } from "effect";
import type { Db } from "../db/index";
import { DbError } from "../domain/errors";
import { DbService } from "../services/Db";

/**
 * Run a synchronous Drizzle call, failing with a tagged {@link DbError}
 * instead of throwing. For code that already holds its `db` handle.
 */
export const dbTry = <A>(label: string, run: () => A): Effect.Effect<A, DbError> =>
  Effect.try({
    try: run,
    catch: (cause) => new DbError({ message: `${label} failed: ${String(cause)}`, cause }),
  });

/** {@link dbTry} with the handle read from {@link DbService}. */
export const tryDb = <A>(label: string, run: (db: Db) => A): Effect.Effect<A, DbError, DbService> =>
  Effect.flatMap(DbService, ({ db }) => dbTry(label, () => run(db)));
