import { Context, Layer } from "effect";
import { createDb, type Db } from "../db/index";

export class DbService extends Context.Service<DbService, { readonly db: Db }>()("DbService") {}

let appDb: Db | undefined;

/** The process's one connection to the app database, opened and migrated on first use. */
export function appDatabase(): Db {
  appDb ??= createDb();
  return appDb;
}

export const DbServiceLive = Layer.sync(DbService, () => ({ db: appDatabase() }));
