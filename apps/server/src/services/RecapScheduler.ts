// ─── RecapScheduler ──────────────────────────────────────────────────────────
//
// Periodic-job pattern modeled after PollScheduler. Two fibers (daily +
// weekly) wake every 15 minutes, sweep every repository, and enqueue a
// recap job for any (repo, period, periodStart) that lacks a non-superseded
// row AND has at least one archived PR in its window.
//
// Cold-start backfill: on first tick after boot we look back up to N
// periods so a multi-day outage self-heals instead of leaving permanent
// gaps in the recap history.
//
// Empty windows skip: if `listArchivedPrsForWindow` returns 0 PRs for a
// candidate period, no row is inserted. The recap list shows a gap rather
// than a "nothing to report" placeholder (plan: cross-cutting decisions).
//
// Per CLAUDE.md invariant #14, the scheduler is ephemeral coordination —
// no state lives in memory that we can't reconstruct from the DB. Status
// transitions go through ProjectRecapJobs (single-writer per invariant #11).

import type { RecapPeriod } from "@revv/shared";
import { Cause, Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from "effect";
import { withDb } from "../effects/with-db";
import { debug, logError } from "../logger";
import { DbService } from "./Db";
import { ProjectRecapService } from "./ProjectRecap";
import { ProjectRecapJobs } from "./ProjectRecapJobs";
import { PullRequestService } from "./PullRequest";
import { RepositoryService } from "./Repository";
import { SettingsService } from "./Settings";

// ── Constants ────────────────────────────────────────────────────────────────

/** How often the fibers check for due recaps. 15 minutes is fine — recaps are slow-moving. */
const RECAP_CHECK_INTERVAL_MINUTES = 15;

/** Backfill window for daily recaps on boot. */
const DAILY_BACKFILL_DAYS = 7;

/** Backfill window for weekly recaps on boot. */
const WEEKLY_BACKFILL_WEEKS = 4;

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const ONE_WEEK_MS = 7 * ONE_DAY_MS;

// ── Period boundary math (UTC) ───────────────────────────────────────────────

/**
 * Start of the day in UTC for the given Date (midnight). Returned as a
 * fresh Date object so callers can compare or format without mutating the
 * input.
 */
export function startOfUtcDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

/**
 * Start of the ISO week (Monday) in UTC for the given Date. ISO weeks
 * begin Monday — Sunday is treated as part of the previous week.
 */
export function startOfUtcIsoWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  const dow = day.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysFromMonday = (dow + 6) % 7; // Sun -> 6, Mon -> 0, ..., Sat -> 5
  return new Date(day.getTime() - daysFromMonday * ONE_DAY_MS);
}

/**
 * Compute the correct period boundaries when regenerating a recap.
 * If the recap's periodStart matches the current rolling window (today /
 * this week), return a rolling window ending at `now`. Otherwise return
 * the canonical full-period boundaries for the historical start.
 */
export function canonicalRecapBoundaries(
  period: RecapPeriod,
  periodStart: string,
  now: Date = new Date(),
): { periodStart: string; periodEnd: string } {
  const start = new Date(periodStart);
  if (period === "daily") {
    const canonicalStart = startOfUtcDay(start);
    const todayStart = startOfUtcDay(now);
    if (canonicalStart.getTime() === todayStart.getTime()) {
      return { periodStart: canonicalStart.toISOString(), periodEnd: now.toISOString() };
    }
    const end = new Date(canonicalStart.getTime() + ONE_DAY_MS);
    return { periodStart: canonicalStart.toISOString(), periodEnd: end.toISOString() };
  }
  const canonicalStart = startOfUtcIsoWeek(start);
  const thisWeekStart = startOfUtcIsoWeek(now);
  if (canonicalStart.getTime() === thisWeekStart.getTime()) {
    return { periodStart: canonicalStart.toISOString(), periodEnd: now.toISOString() };
  }
  const end = new Date(canonicalStart.getTime() + ONE_WEEK_MS);
  return { periodStart: canonicalStart.toISOString(), periodEnd: end.toISOString() };
}

/**
 * Enumerate candidate periods, newest → oldest. For daily, returns the
 * `[N, N-1, N-2, ...]` days ending with the most-recently-closed window
 * (yesterday 00:00 → today 00:00 UTC). For weekly, the same shape but
 * ISO weeks.
 *
 * The "most-recently-closed" window for daily is `[yesterday, today)` —
 * we don't generate a recap for the current in-progress day.
 */
function enumerateDailyPeriods(
  now: Date,
  count: number,
): Array<{ periodStart: string; periodEnd: string }> {
  const todayStart = startOfUtcDay(now);
  const result: Array<{ periodStart: string; periodEnd: string }> = [];
  for (let i = 1; i <= count; i++) {
    const end = new Date(todayStart.getTime() - (i - 1) * ONE_DAY_MS);
    const start = new Date(end.getTime() - ONE_DAY_MS);
    result.push({
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
    });
  }
  return result;
}

function enumerateWeeklyPeriods(
  now: Date,
  count: number,
): Array<{ periodStart: string; periodEnd: string }> {
  const thisWeekStart = startOfUtcIsoWeek(now);
  const result: Array<{ periodStart: string; periodEnd: string }> = [];
  for (let i = 1; i <= count; i++) {
    const end = new Date(thisWeekStart.getTime() - (i - 1) * ONE_WEEK_MS);
    const start = new Date(end.getTime() - ONE_WEEK_MS);
    result.push({
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
    });
  }
  return result;
}

// ── Service tag ──────────────────────────────────────────────────────────────

type RecapSchedulerService = {
  readonly start: () => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;
  /**
   * Trigger a one-shot sweep across all repos for the given period
   * cadence. Used by the manual "generate now" route and on boot for
   * backfill. Idempotent against existing rows.
   */
  readonly checkNow: (period: RecapPeriod) => Effect.Effect<void>;
};

export class RecapScheduler extends Context.Tag("RecapScheduler")<
  RecapScheduler,
  RecapSchedulerService
>() {}

// ── Live implementation ──────────────────────────────────────────────────────

export const RecapSchedulerLive = Layer.effect(
  RecapScheduler,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const settingsService = yield* SettingsService;
    const repoService = yield* RepositoryService;
    const prService = yield* PullRequestService;
    const recapService = yield* ProjectRecapService;
    const recapJobs = yield* ProjectRecapJobs;

    const provideDb = <A, E>(eff: Effect.Effect<A, E, DbService>): Effect.Effect<A, E> =>
      withDb(db, eff);

    const dailyFiberRef = yield* Ref.make<Fiber.RuntimeFiber<number, never> | null>(null);
    const weeklyFiberRef = yield* Ref.make<Fiber.RuntimeFiber<number, never> | null>(null);

    // True until the first tick after boot completes. Cold-start backfills
    // use the wider lookback; subsequent ticks only look at the current
    // period (yesterday for daily, last week for weekly) because the
    // scheduler ran successfully before the boundary closed.
    const dailyBackfilledRef = yield* Ref.make(false);
    const weeklyBackfilledRef = yield* Ref.make(false);

    const sweepPeriod = (period: RecapPeriod): Effect.Effect<void> =>
      Effect.gen(function* () {
        const repos = yield* provideDb(repoService.listRepos()).pipe(
          Effect.orElseSucceed(() => []),
        );
        if (repos.length === 0) return;

        const now = new Date();
        const backfilledRef = period === "daily" ? dailyBackfilledRef : weeklyBackfilledRef;
        const alreadyBackfilled = yield* Ref.get(backfilledRef);
        const lookback = alreadyBackfilled
          ? 1
          : period === "daily"
            ? DAILY_BACKFILL_DAYS
            : WEEKLY_BACKFILL_WEEKS;

        const candidates =
          period === "daily"
            ? enumerateDailyPeriods(now, lookback)
            : enumerateWeeklyPeriods(now, lookback);

        for (const repo of repos) {
          for (const window of candidates) {
            const existing = yield* provideDb(
              recapService.findActiveForPeriod(repo.id, period, window.periodStart),
            ).pipe(Effect.catchAll(() => Effect.succeed(null)));

            // ── Daily stale-check ────────────────────────────────────────
            // If a daily recap for this window was generated today, it's
            // fresh — skip. If it was generated before today, it's stale
            // (new PRs may have merged since) — regenerate.
            if (existing && period === "daily") {
              const generatedAt = new Date(existing.generatedAt);
              const todayStart = startOfUtcDay(now);
              if (generatedAt.getTime() >= todayStart.getTime()) {
                debug(
                  "recap-scheduler",
                  `skip fresh daily recap for ${repo.fullName} ${window.periodStart}`,
                );
                continue;
              }
              debug(
                "recap-scheduler",
                `regenerate stale daily recap for ${repo.fullName} ${window.periodStart}`,
              );
              yield* recapJobs
                .regenerateForPeriod({
                  repoId: repo.id,
                  period,
                  periodStart: window.periodStart,
                  periodEnd: window.periodEnd,
                })
                .pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.sync(() => {
                      logError(
                        "recap-scheduler",
                        `regenerateForPeriod failed for ${repo.fullName} ${period} ${window.periodStart}:`,
                        Cause.pretty(cause),
                      );
                    }),
                  ),
                );
              continue;
            }

            // Weekly: skip if a non-superseded row already exists.
            if (existing) continue;

            // Skip only when the window has zero archived PRs AND no open
            // PRs. With open PRs alone we can still produce an "active
            // work" recap; only a completely silent repo earns the gap.
            const windowed = yield* provideDb(
              prService.listArchivedPrsForWindow(repo.id, window.periodStart, window.periodEnd),
            ).pipe(Effect.catchAll(() => Effect.succeed([] as never[])));
            if (windowed.length === 0) {
              const openPrs = yield* provideDb(prService.listOpenPrsWithWalkthroughs(repo.id)).pipe(
                Effect.catchAll(() => Effect.succeed([] as never[])),
              );
              if (openPrs.length === 0) continue;
            }

            debug(
              "recap-scheduler",
              `enqueue ${period} recap for ${repo.fullName} window ${window.periodStart}`,
            );
            yield* recapJobs
              .startJob({
                repoId: repo.id,
                period,
                periodStart: window.periodStart,
                periodEnd: window.periodEnd,
                trigger: "scheduler",
              })
              .pipe(
                Effect.catchAllCause((cause) =>
                  Effect.sync(() => {
                    logError(
                      "recap-scheduler",
                      `startJob failed for ${repo.fullName} ${period} ${window.periodStart}:`,
                      Cause.pretty(cause),
                    );
                  }),
                ),
              );
          }
        }

        yield* Ref.set(backfilledRef, true);
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            logError("recap-scheduler", `sweep ${period} failed:`, Cause.pretty(cause));
          }),
        ),
      );

    const startFiberFor = (period: RecapPeriod, ref: typeof dailyFiberRef): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(ref);
        if (existing !== null) return;
        const schedule = Schedule.spaced(Duration.minutes(RECAP_CHECK_INTERVAL_MINUTES));
        const fiber: Fiber.RuntimeFiber<number, never> = yield* Effect.fork(
          sweepPeriod(period).pipe(Effect.repeat(schedule)),
        );
        yield* Ref.set(ref, fiber);
      });

    const stopFiberRef = (ref: typeof dailyFiberRef): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiber = yield* Ref.get(ref);
        if (fiber !== null) {
          yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
          yield* Ref.set(ref, null);
        }
      });

    return {
      start: () =>
        Effect.gen(function* () {
          const settings = yield* provideDb(settingsService.getSettings()).pipe(
            Effect.orElseSucceed(() => null),
          );
          const enabled = recapEnabled(settings);
          if (!enabled.recap) {
            debug("recap-scheduler", "recap disabled — not starting fibers");
            return;
          }
          if (enabled.daily) yield* startFiberFor("daily", dailyFiberRef);
          if (enabled.weekly) yield* startFiberFor("weekly", weeklyFiberRef);
        }),

      stop: () =>
        Effect.gen(function* () {
          yield* stopFiberRef(dailyFiberRef);
          yield* stopFiberRef(weeklyFiberRef);
        }),

      checkNow: (period) => sweepPeriod(period),
    };
  }),
);

// ── Settings shape probe ─────────────────────────────────────────────────────

function recapEnabled(settings: unknown): {
  recap: boolean;
  daily: boolean;
  weekly: boolean;
} {
  // Defaults to all-on. The Settings service stamps these defaults on
  // first read, but if we somehow get a malformed settings object we
  // still want to run.
  const r =
    settings && typeof settings === "object" && "recap" in settings
      ? ((settings as { recap?: unknown }).recap as
          | { enabled?: unknown; dailyEnabled?: unknown; weeklyEnabled?: unknown }
          | undefined)
      : undefined;
  return {
    recap: r?.enabled !== false,
    daily: r?.dailyEnabled !== false,
    weekly: r?.weeklyEnabled !== false,
  };
}

// ── Period helpers exported for the routes ───────────────────────────────────

/**
 * Rolling daily window for manual generation: `[today 00:00 UTC, now]`.
 * This captures "what happened today so far" rather than the fixed
 * yesterday→today window the scheduler uses.
 */
export function manualDailyBoundaries(now: Date = new Date()): {
  periodStart: string;
  periodEnd: string;
} {
  const start = startOfUtcDay(now);
  return {
    periodStart: start.toISOString(),
    periodEnd: now.toISOString(),
  };
}

/**
 * Rolling weekly window for manual generation: `[start-of-current-ISO-week
 * 00:00 UTC, now]`. Captures "what's shipped this week so far" rather
 * than the fixed last-closed-week window the scheduler uses. ISO weeks
 * start on Monday.
 */
export function manualWeeklyBoundaries(now: Date = new Date()): {
  periodStart: string;
  periodEnd: string;
} {
  const start = startOfUtcIsoWeek(now);
  return {
    periodStart: start.toISOString(),
    periodEnd: now.toISOString(),
  };
}
