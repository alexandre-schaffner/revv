// ── Project recap routes ────────────────────────────────────────────────────
//
// HTTP surface for the daily / weekly recap pipeline. Read endpoints serve
// the UI's list + detail views; mutation endpoints kick off generation
// (idempotent against an existing non-superseded row) and explicit
// regeneration (supersede + queue new).
//
// All routes are behind `withAuth`. Errors come back via `handleAppError`
// so the existing tagged-error → HTTP mapping handles `RecapNotFoundError`
// → 404, `ValidationError` → 400 etc.

import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { ProjectRecapService } from "../services/ProjectRecap";
import { ProjectRecapJobs } from "../services/ProjectRecapJobs";
import {
  canonicalRecapBoundaries,
  manualDailyBoundaries,
  manualWeeklyBoundaries,
} from "../services/RecapScheduler";
import { handleAppError, withAuth } from "./middleware";
import { recapStreamHandler } from "./recaps/stream";

function parsePeriod(value: string | undefined): "daily" | "weekly" | undefined {
  if (value === "daily" || value === "weekly") return value;
  return undefined;
}

export const recapRoutes = new Elysia({ prefix: "/api" })
  .use(withAuth)
  // ─── GET /api/repos/:id/recaps ─────────────────────────────────────────
  .get(
    "/repos/:id/recaps",
    async (ctx) => {
      try {
        const params: {
          period?: "daily" | "weekly";
          cursor?: string;
          limit?: number;
          includeSuperseded?: boolean;
        } = {};
        const p = parsePeriod(ctx.query.period);
        if (p !== undefined) params.period = p;
        if (ctx.query.cursor !== undefined) params.cursor = ctx.query.cursor;
        if (ctx.query.limit !== undefined) {
          const n = Number(ctx.query.limit);
          if (Number.isFinite(n) && n > 0) params.limit = Math.floor(n);
        }
        if (ctx.query.includeSuperseded === "true") params.includeSuperseded = true;

        return await AppRuntime.runPromise(
          Effect.flatMap(ProjectRecapService, (s) => s.listForRepo(ctx.params.id, params)),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      query: t.Object({
        period: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        includeSuperseded: t.Optional(t.String()),
      }),
    },
  )
  // ─── GET /api/recaps/:id ───────────────────────────────────────────────
  .get("/recaps/:id", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id)),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  // ─── POST /api/repos/:id/recaps/generate ───────────────────────────────
  // Body: { period: "daily" | "weekly", periodStart?, periodEnd? }.
  // Defaults to the most-recently-closed period for the cadence. Idempotent
  // unless `?regenerate=true`, in which case the existing non-superseded
  // row is superseded and a fresh job is queued.
  .post(
    "/repos/:id/recaps/generate",
    async (ctx) => {
      try {
        const body = ctx.body;
        const period = parsePeriod(body.period);
        if (!period) {
          ctx.set.status = 400;
          return { error: "period must be 'daily' or 'weekly'" };
        }

        // Manual daily/weekly default to a rolling "current period so far"
        // window (today/this-week 00:00 UTC → now) rather than the fixed
        // most-recently-closed window the scheduler uses. The caller can
        // override by supplying an explicit periodStart/periodEnd.
        const usingRollingWindow = body.periodStart === undefined;
        const rolling = period === "daily" ? manualDailyBoundaries() : manualWeeklyBoundaries();
        const periodStart = body.periodStart ?? rolling.periodStart;
        const periodEnd = body.periodEnd ?? rolling.periodEnd;

        const regenerate = ctx.query.regenerate === "true";

        if (regenerate) {
          return await AppRuntime.runPromise(
            Effect.flatMap(ProjectRecapJobs, (jobs) =>
              jobs.regenerateForPeriod({
                repoId: ctx.params.id,
                period,
                periodStart,
                periodEnd,
              }),
            ),
          );
        }

        const existing = await AppRuntime.runPromise(
          Effect.flatMap(ProjectRecapService, (s) =>
            s.findActiveForPeriod(ctx.params.id, period, periodStart),
          ),
        );

        // Rolling-window manual triggers are non-idempotent: if a recap
        // for the current rolling window already exists, supersede it so
        // the user always gets the freshest snapshot. Explicit-period
        // requests stay idempotent — the caller pinned the boundaries
        // and re-running would produce the same recap.
        if (existing && usingRollingWindow) {
          return await AppRuntime.runPromise(
            Effect.flatMap(ProjectRecapJobs, (jobs) =>
              jobs.regenerateForPeriod({
                repoId: ctx.params.id,
                period,
                periodStart,
                periodEnd,
              }),
            ),
          );
        }

        if (existing) {
          return { recapId: existing.id };
        }

        return await AppRuntime.runPromise(
          Effect.flatMap(ProjectRecapJobs, (jobs) =>
            jobs.startJob({
              repoId: ctx.params.id,
              period,
              periodStart,
              periodEnd,
              trigger: "manual",
            }),
          ),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      body: t.Object({
        period: t.String(),
        periodStart: t.Optional(t.String()),
        periodEnd: t.Optional(t.String()),
      }),
      query: t.Object({
        regenerate: t.Optional(t.String()),
      }),
    },
  )
  // ─── POST /api/recaps/:id/regenerate ───────────────────────────────────
  // Regenerate the recap using the correct window for its period.
  // If the recap belongs to the current rolling window (today / this week),
  // the end boundary advances to `now` so new PRs are included. For
  // historical recaps the canonical full-period boundaries are used.
  .post("/recaps/:id/regenerate", async (ctx) => {
    try {
      const existing = await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id)),
      );
      const boundaries = canonicalRecapBoundaries(existing.period, existing.periodStart);
      return await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapJobs, (jobs) =>
          jobs.regenerateForPeriod({
            repoId: existing.repositoryId,
            period: existing.period,
            periodStart: boundaries.periodStart,
            periodEnd: boundaries.periodEnd,
          }),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  // ─── POST /api/recaps/:id/stop ─────────────────────────────────────────
  // Cancel an in-flight recap generation. Sets `cancelledByUser=true`,
  // aborts the agent's AbortController, and interrupts the fiber. The
  // `buildJobBody` cancellation branch then transitions status to
  // 'error' with message "Cancelled by user", and broadcasts the change
  // via WS so other clients update. No-op if no live job is registered
  // for this recapId (e.g. it already finished or was never started).
  .post("/recaps/:id/stop", async (ctx) => {
    try {
      await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapJobs, (jobs) => jobs.cancel(ctx.params.id)),
      );
      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  // ─── GET /api/recaps/:id/stream ────────────────────────────────────────
  // SSE endpoint for live recap generation. Returns markdown chunks as
  // the AI composes them, plus phase shimmer events.
  .get("/recaps/:id/stream", recapStreamHandler);
