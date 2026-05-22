import { and, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from "effect";
import { cacheEntries, kvCache, pullRequests } from "../db/schema/index";
import { logError } from "../logger";
import { DbService } from "./Db";

const SWEEP_INTERVAL_HOURS = 6;
const PR_RETENTION_DAYS = 7;

type DbMaintenanceService = {
  readonly start: () => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;
  readonly runNow: () => Effect.Effect<void>;
};

export class DbMaintenance extends Context.Tag("DbMaintenance")<
  DbMaintenance,
  DbMaintenanceService
>() {}

export const DbMaintenanceLive = Layer.effect(
  DbMaintenance,
  Effect.gen(function* () {
    const { db } = yield* DbService;

    const runMaintenance: Effect.Effect<void> = Effect.sync(() => {
      const nowIso = new Date().toISOString();
      const prCutoffIso = new Date(
        Date.now() - PR_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();

      // 1. Sweep expired cache_entries rows
      const expiredCacheEntries = db
        .select({ n: sql<number>`COUNT(*)` })
        .from(cacheEntries)
        .where(lt(cacheEntries.expiresAt, nowIso))
        .get();
      const cacheEntriesSwept = expiredCacheEntries?.n ?? 0;
      if (cacheEntriesSwept > 0) {
        db.delete(cacheEntries).where(lt(cacheEntries.expiresAt, nowIso)).run();
      }

      // 2. Sweep expired kv_cache rows
      const expiredKv = db
        .select({ n: sql<number>`COUNT(*)` })
        .from(kvCache)
        .where(lt(kvCache.expiresAt, nowIso))
        .get();
      const kvSwept = expiredKv?.n ?? 0;
      if (kvSwept > 0) {
        db.delete(kvCache).where(lt(kvCache.expiresAt, nowIso)).run();
      }

      // 3. Sweep archived PRs older than the retention window. Cascades clean
      // walkthroughs, review sessions, chat sessions, diff files, and pinned
      // rows via the schema's onDelete: "cascade" declarations.
      const expiredPrsPredicate = and(
        inArray(pullRequests.status, ["closed", "merged"]),
        isNotNull(pullRequests.closedAt),
        lt(pullRequests.closedAt, prCutoffIso),
      );
      const expiredPrs = db
        .select({ n: sql<number>`COUNT(*)` })
        .from(pullRequests)
        .where(expiredPrsPredicate)
        .get();
      const prsSwept = expiredPrs?.n ?? 0;
      if (prsSwept > 0) {
        db.delete(pullRequests).where(expiredPrsPredicate).run();
      }

      // 4. Checkpoint WAL to reclaim disk space from the WAL file
      db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);

      const total = cacheEntriesSwept + kvSwept + prsSwept;
      if (total > 0) {
        logError(
          "DbMaintenance",
          `sweep complete — cache_entries: ${cacheEntriesSwept} rows, kv_cache: ${kvSwept} rows, pull_requests: ${prsSwept} rows, WAL checkpointed`,
        );
      }
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          logError("DbMaintenance", "maintenance run failed:", cause);
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
