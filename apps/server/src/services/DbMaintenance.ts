import { and, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from "effect";
import { cacheEntries, githubEtagCache, kvCache, pullRequests } from "../db/schema/index";
import { logError } from "../logger";
import { DbService } from "./Db";

const SWEEP_INTERVAL_HOURS = 6;
const PR_RETENTION_DAYS = 7;
/**
 * Retention for `github_etag_cache`.
 *
 * Unlike `cache_entries` / `kv_cache`, rows here carry no `expires_at` — an
 * ETag stays valid indefinitely — so without a sweep the table only grows. Two
 * things grow it fast: `listReviewComments` folds its advancing `since`
 * watermark into the cache key, so every watermark move for every PR leaves a
 * permanently-unreachable row behind; and `listPrs` stores the entire
 * accumulated multi-page body, which is megabytes for a repo with hundreds of
 * open PRs.
 *
 * A week is comfortably longer than any live key's reuse interval (the poll
 * touches every active key every few minutes), so this only ever reaps rows
 * nothing will ask for again. Reaping a still-live key would cost one
 * unconditional refetch, not a correctness bug.
 */
const ETAG_CACHE_RETENTION_DAYS = 7;

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

      // 4. Sweep GitHub conditional-request cache rows not touched in a week.
      // `fetched_at` is refreshed on every 200 AND left alone on a 304, so it
      // is a last-write time, not a last-use time — which is the conservative
      // direction: a key still being replayed via 304s can be reaped, costing
      // one unconditional refetch, whereas a key genuinely in use as a 200
      // target keeps getting stamped and survives.
      const etagCutoffIso = new Date(
        Date.now() - ETAG_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const expiredEtags = db
        .select({ n: sql<number>`COUNT(*)` })
        .from(githubEtagCache)
        .where(lt(githubEtagCache.fetchedAt, etagCutoffIso))
        .get();
      const etagsSwept = expiredEtags?.n ?? 0;
      if (etagsSwept > 0) {
        db.delete(githubEtagCache).where(lt(githubEtagCache.fetchedAt, etagCutoffIso)).run();
      }

      // 5. Checkpoint WAL to reclaim disk space from the WAL file
      db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);

      const total = cacheEntriesSwept + kvSwept + prsSwept + etagsSwept;
      if (total > 0) {
        logError(
          "DbMaintenance",
          `sweep complete — cache_entries: ${cacheEntriesSwept} rows, kv_cache: ${kvSwept} rows, pull_requests: ${prsSwept} rows, github_etag_cache: ${etagsSwept} rows, WAL checkpointed`,
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
