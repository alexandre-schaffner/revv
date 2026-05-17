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
import { currentPeriodBoundaries } from "../services/RecapScheduler";
import { handleAppError, withAuth } from "./middleware";

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
        const defaults = currentPeriodBoundaries(period);
        const periodStart = body.periodStart ?? defaults.periodStart;
        const periodEnd = body.periodEnd ?? defaults.periodEnd;

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

        // Idempotent: if a non-superseded row already exists for this
        // period, hand back its id instead of forking a duplicate job.
        const existing = await AppRuntime.runPromise(
          Effect.flatMap(ProjectRecapService, (s) =>
            s.findActiveForPeriod(ctx.params.id, period, periodStart),
          ),
        );
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
  // Convenience endpoint that supersedes the existing row at the same
  // period boundaries and queues a fresh job. Equivalent to calling
  // /repos/:id/recaps/generate?regenerate=true with the same boundaries.
  .post("/recaps/:id/regenerate", async (ctx) => {
    try {
      const existing = await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id)),
      );
      return await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapJobs, (jobs) =>
          jobs.regenerateForPeriod({
            repoId: existing.repositoryId,
            period: existing.period,
            periodStart: existing.periodStart,
            periodEnd: existing.periodEnd,
          }),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });
