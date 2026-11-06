import { Effect } from "effect";
import type { Db } from "../db/index";
import { DbService } from "../services/Db";

/**
 * Thread a `db` already resolved inside a `Layer.effect` closure into nested
 * effects that still declare `DbService`, without providing the full layer.
 */
export const withDb = <A, E>(db: Db, eff: Effect.Effect<A, E, DbService>): Effect.Effect<A, E> =>
  Effect.provideService(eff, DbService, { db });
