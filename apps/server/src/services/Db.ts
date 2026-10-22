import { Context, Layer } from "effect";
import { createDb, type Db } from "../db/index";

export class DbService extends Context.Service<DbService, { readonly db: Db }>()("DbService") {}

export const DbServiceLive = Layer.sync(DbService, () => ({
  db: createDb(),
}));
