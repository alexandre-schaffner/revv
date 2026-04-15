import { Context, Layer } from 'effect';
import { createDb, type Db } from '../db/index';

export class DbService extends Context.Tag('DbService')<DbService, { readonly db: Db }>() {}

export const DbServiceLive = Layer.sync(DbService, () => ({
	db: createDb(),
}));
