import { lt, sql } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
import type { RetentionPolicy } from "../db/retention";
import { cacheEntries } from "../db/schema/index";
import { makeRestartableLoop } from "../effects/restartable-loop";
import { logError } from "../logger";
import { kvCacheRetention } from "./Cache";
import { DbService } from "./Db";
import { etagCacheRetention } from "./GitHubEtagCache";
import { prArchiveRetention } from "./poll-maintenance";

const SWEEP_INTERVAL_HOURS = 6;

const cacheEntriesRetention: RetentionPolicy = {
  table: "cache_entries",
  sweep: (db, now) =>
    db
      .delete(cacheEntries)
      .where(lt(cacheEntries.expiresAt, now.toISOString()))
      .returning({ key: cacheEntries.key })
      .all().length,
};

const POLICIES: readonly RetentionPolicy[] = [
  cacheEntriesRetention,
  kvCacheRetention,
  prArchiveRetention,
  etagCacheRetention,
];

type DbMaintenanceService = {
  readonly start: () => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;
};

export class DbMaintenance extends Context.Service<DbMaintenance, DbMaintenanceService>()(
  "DbMaintenance",
) {}

/** Runs every feature's retention policy, then checkpoints the WAL, on start and every 6 hours. */
export const DbMaintenanceLive = Layer.effect(
  DbMaintenance,
  Effect.gen(function* () {
    const sweep = yield* makeRestartableLoop;
    const { db } = yield* DbService;

    const runMaintenance: Effect.Effect<void> = Effect.sync(() => {
      const now = new Date();
      const swept = POLICIES.map((policy) => ({
        table: policy.table,
        rows: policy.sweep(db, now),
      }));
      db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
      if (swept.some((s) => s.rows > 0)) {
        const counts = swept.map((s) => `${s.table}: ${s.rows} rows`).join(", ");
        logError("DbMaintenance", `sweep complete — ${counts}, WAL checkpointed`);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          logError("DbMaintenance", "maintenance run failed:", cause);
        }),
      ),
    );

    return {
      start: () =>
        sweep.start(
          runMaintenance.pipe(Effect.repeat(Schedule.spaced(Duration.hours(SWEEP_INTERVAL_HOURS)))),
        ),
      stop: () => sweep.stop,
    };
  }),
);
