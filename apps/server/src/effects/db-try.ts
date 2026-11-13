import { Effect } from "effect";
import { DbError } from "../domain/errors";

/**
 * Run a synchronous Drizzle call, failing with a tagged {@link DbError}
 * instead of throwing.
 */
export const dbTry = <A>(label: string, run: () => A): Effect.Effect<A, DbError> =>
  Effect.try({
    try: run,
    catch: (cause) => new DbError({ message: `${label} failed: ${String(cause)}`, cause }),
  });
