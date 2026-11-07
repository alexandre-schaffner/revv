import { sql } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
import type { RetentionPolicy } from "../db/retention";
import { makeRestartableLoop } from "../effects/restartable-loop";
import { logError } from "../logger";
import { kvCacheRetention } from "./Cache";
import { DbService } from "./Db";
import { sessionRetention } from "./github/accounts";
import { etagCacheRetention } from "./github/etag-cache";
import { prArchiveRetention } from "./poll-maintenance";

const SWEEP_INTERVAL_HOURS = 6;

const POLICIES: readonly RetentionPolicy[] = [
  kvCacheRetention,
  prArchiveRetention,
  etagCacheRetention,
  sessionRetention,
];

type DbMaintenanceService = {
  readonly start: () => Effect.Effect<void>;
};

export class DbMaintenance extends Context.Service<DbMaintenance, DbMaintenanceService>()(
  "DbMaintenance",
) {}

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
    };
  }),
);
