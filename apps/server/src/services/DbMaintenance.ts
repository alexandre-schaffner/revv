import { Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from 'effect';
import { lt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { cacheEntries, kvCache } from '../db/schema/index';
import { DbService } from './Db';

const SWEEP_INTERVAL_HOURS = 6;

type DbMaintenanceService = {
	readonly start: () => Effect.Effect<void>;
	readonly stop: () => Effect.Effect<void>;
	readonly runNow: () => Effect.Effect<void>;
};

export class DbMaintenance extends Context.Tag('DbMaintenance')<
	DbMaintenance,
	DbMaintenanceService
>() {}

export const DbMaintenanceLive = Layer.effect(
	DbMaintenance,
	Effect.gen(function* () {
		const { db } = yield* DbService;

		const runMaintenance: Effect.Effect<void> = Effect.gen(function* () {
			const nowIso = new Date().toISOString();

			// 1. Sweep expired cache_entries rows
			const expiredCacheEntries = db
				.select({ n: sql<number>`COUNT(*)` })
				.from(cacheEntries)
				.where(lt(cacheEntries.expiresAt, nowIso))
				.get();
			const cacheEntriesSwept = expiredCacheEntries?.n ?? 0;
			if (cacheEntriesSwept > 0) {
				db.delete(cacheEntries)
					.where(lt(cacheEntries.expiresAt, nowIso))
					.run();
			}

			// 2. Sweep expired kv_cache rows
			const expiredKv = db
				.select({ n: sql<number>`COUNT(*)` })
				.from(kvCache)
				.where(lt(kvCache.expiresAt, nowIso))
				.get();
			const kvSwept = expiredKv?.n ?? 0;
			if (kvSwept > 0) {
				db.delete(kvCache)
					.where(lt(kvCache.expiresAt, nowIso))
					.run();
			}

			// 3. Checkpoint WAL to reclaim disk space from the WAL file
			db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);

			const total = cacheEntriesSwept + kvSwept;
			if (total > 0) {
				console.log(
					`[DbMaintenance] sweep complete — cache_entries: ${cacheEntriesSwept} rows, kv_cache: ${kvSwept} rows, WAL checkpointed`,
				);
			}
		}).pipe(
			Effect.catchAllCause((cause) =>
				Effect.sync(() => {
					console.error('[DbMaintenance] maintenance run failed:', cause);
				}),
			),
		);

		const fiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null);

		return {
			start: () =>
				Effect.gen(function* () {
					const existing = yield* Ref.get(fiberRef);
					if (existing !== null) return; // already running

					// Run once immediately on start, then repeat every 6 hours
					const schedule = Schedule.spaced(Duration.hours(SWEEP_INTERVAL_HOURS));
					const fiber = yield* Effect.fork(
						runMaintenance.pipe(Effect.repeat(schedule), Effect.asVoid),
					);
					yield* Ref.set(fiberRef, fiber);
				}),

			stop: () =>
				Effect.gen(function* () {
					const fiber = yield* Ref.get(fiberRef);
					if (fiber !== null) {
						yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
						yield* Ref.set(fiberRef, null);
					}
				}),

			runNow: () => runMaintenance,
		};
	}),
);
