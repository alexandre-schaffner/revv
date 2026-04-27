import { Effect } from "effect";
import type { Db } from "../db/index";
import { DbService } from "../services/Db";

/**
 * Provide a captured `db` handle to an effect that requires DbService.
 *
 * Inside a `Layer.effect` closure the `db` has already been resolved from
 * the layer's dependencies. This helper lets you thread it into nested
 * effects that still declare `DbService` in their `R` channel without
 * requiring the full layer.
 */
export const withDb = <A, E>(
  db: Db,
  eff: Effect.Effect<A, E, DbService>,
): Effect.Effect<A, E> => Effect.provideService(eff, DbService, { db });
