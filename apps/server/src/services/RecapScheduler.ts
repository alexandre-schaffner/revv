// Two fibers (daily + weekly) sweep every repository and ask
// `ProjectRecapJobs.requestRecap` for each recently closed window. Whether a
// window gets a recap, keeps the one it has, or has it rerun is that
// method's call; this loop only enumerates windows.
//
// Cold-start backfill: on first tick after boot we look back up to N
// periods so a multi-day outage self-heals instead of leaving permanent
// gaps in the recap history.
//
// Ephemeral coordination (invariant 1): nothing in memory that can't be
// rebuilt from the DB. Status transitions go through ProjectRecapJobs
// (invariant 11).

import { closedWindows, type RecapPeriod } from "@revv/shared";
import { Cause, Context, Duration, Effect, Layer, Ref, Schedule, Stream } from "effect";
import { makeRestartableLoop } from "../effects/restartable-loop";
import { withDb } from "../effects/with-db";
import { debug, logError } from "../logger";
import { withGitHubOrigin } from "../observability/github-ledger/origin";
import { DbService } from "./Db";
import { ProjectRecapJobs } from "./ProjectRecapJobs";
import { RepositoryService } from "./Repository";
import { SettingsService } from "./Settings";

/** Recaps are slow-moving. */
const RECAP_CHECK_INTERVAL_MINUTES = 15;

/** How many closed windows the first sweep after boot looks back over. */
const BACKFILL: Record<RecapPeriod, number> = { daily: 7, weekly: 4 };

type RecapSchedulerService = {
  readonly start: () => Effect.Effect<void>;
};

export class RecapScheduler extends Context.Service<RecapScheduler, RecapSchedulerService>()(
  "RecapScheduler",
) {}

export const RecapSchedulerLive = Layer.effect(
  RecapScheduler,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const settingsService = yield* SettingsService;
    const repoService = yield* RepositoryService;
    const recapJobs = yield* ProjectRecapJobs;

    const provideDb = <A, E>(eff: Effect.Effect<A, E, DbService>): Effect.Effect<A, E> =>
      withDb(db, eff);

    const dailyLoop = yield* makeRestartableLoop;
    const weeklyLoop = yield* makeRestartableLoop;

    // True once a sweep has covered the backfill; later sweeps only need the
    // window that closed last.
    const backfilled: Record<RecapPeriod, Ref.Ref<boolean>> = {
      daily: yield* Ref.make(false),
      weekly: yield* Ref.make(false),
    };

    const sweepPeriod = (period: RecapPeriod): Effect.Effect<void> =>
      Effect.gen(function* () {
        const repos = yield* provideDb(repoService.listRepos()).pipe(
          Effect.orElseSucceed(() => []),
        );
        if (repos.length === 0) return;

        const lookback = (yield* Ref.get(backfilled[period])) ? 1 : BACKFILL[period];
        const windows = closedWindows(period, new Date(), lookback);

        for (const repo of repos) {
          for (const window of windows) {
            yield* recapJobs
              .requestRecap({ repoId: repo.id, period, window, intent: "scheduled" })
              .pipe(
                Effect.tap((started) =>
                  Effect.sync(() => {
                    if (started) {
                      debug(
                        "recap-scheduler",
                        `${period} recap ${started.recapId} for ${repo.fullName} ${window.periodStart}`,
                      );
                    }
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.sync(() => {
                    logError(
                      "recap-scheduler",
                      `requestRecap failed for ${repo.fullName} ${period} ${window.periodStart}:`,
                      Cause.pretty(cause),
                    );
                  }),
                ),
              );
          }
        }

        yield* Ref.set(backfilled[period], true);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            logError("recap-scheduler", `sweep ${period} failed:`, Cause.pretty(cause));
          }),
        ),
      );

    const sweepLoop = (period: RecapPeriod) =>
      sweepPeriod(period).pipe(
        withGitHubOrigin(`recap:sweep:${period}`),
        Effect.repeat(Schedule.spaced(Duration.minutes(RECAP_CHECK_INTERVAL_MINUTES))),
      );

    const start = Effect.gen(function* () {
      const { recap } = yield* settingsService.getSettings();
      if (!recap.enabled) {
        debug("recap-scheduler", "recap disabled — not starting fibers");
        return;
      }
      if (recap.dailyEnabled) yield* dailyLoop.start(sweepLoop("daily"));
      if (recap.weeklyEnabled) yield* weeklyLoop.start(sweepLoop("weekly"));
    });

    // Toggling a cadence applies live. An agent-only change doesn't restart:
    // a restart sweeps immediately.
    yield* Effect.forkScoped(
      settingsService
        .watch(({ recap }) => `${recap.enabled}:${recap.dailyEnabled}:${recap.weeklyEnabled}`)
        .pipe(
          Stream.runForEach(() =>
            Effect.gen(function* () {
              yield* dailyLoop.stop;
              yield* weeklyLoop.stop;
              yield* start;
            }),
          ),
        ),
    );

    return {
      start: () => start,
    };
  }),
);
