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

import { canonicalWindow } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { ProjectRecapService } from "../services/ProjectRecap";
import { ProjectRecapJobs } from "../services/ProjectRecapJobs";
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
          from?: string;
          to?: string;
        } = {};
        const p = parsePeriod(ctx.query.period);
        if (p !== undefined) params.period = p;
        if (ctx.query.cursor !== undefined) params.cursor = ctx.query.cursor;
        if (ctx.query.limit !== undefined) {
          const n = Number(ctx.query.limit);
          if (Number.isFinite(n) && n > 0) params.limit = Math.floor(n);
        }
        if (ctx.query.includeSuperseded === "true") params.includeSuperseded = true;
        // `from`/`to` bound `periodStart`, not `generatedAt`. Garbage is
        // dropped rather than 400'd (mirrors the `limit` guard) — and the
        // parse check matters beyond tidiness: the predicate compares
        // strings, so an unvalidated value would still match
        // lexicographically and silently return the wrong rows.
        if (ctx.query.from !== undefined && Number.isFinite(Date.parse(ctx.query.from))) {
          params.from = ctx.query.from;
        }
        if (ctx.query.to !== undefined && Number.isFinite(Date.parse(ctx.query.to))) {
          params.to = ctx.query.to;
        }

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
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
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
  // Body: { period: "daily" | "weekly", periodStart?, periodEnd? }. Without
  // boundaries it asks for the open window so far (today / this week up to
  // now); `?regenerate=true` reruns the window's recap rather than reusing it.
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
        const pinned =
          body.periodStart === undefined
            ? undefined
            : {
                periodStart: body.periodStart,
                periodEnd: body.periodEnd ?? new Date().toISOString(),
              };
        return await AppRuntime.runPromise(
          Effect.flatMap(ProjectRecapJobs, (jobs) =>
            jobs.requestRecap({
              repoId: ctx.params.id,
              period,
              ...(pinned ? { window: pinned } : {}),
              intent: ctx.query.regenerate === "true" ? "regenerate" : "manual",
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
  // Rerun the recap over its window as it stands now: up to now while the
  // window is open, the whole period once it has closed.
  .post("/recaps/:id/regenerate", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const existing = yield* Effect.flatMap(ProjectRecapService, (s) =>
            s.getById(ctx.params.id),
          );
          const jobs = yield* ProjectRecapJobs;
          return yield* jobs.requestRecap({
            repoId: existing.repositoryId,
            period: existing.period,
            window: canonicalWindow(existing.period, existing.periodStart),
            intent: "regenerate",
          });
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  // ─── POST /api/recaps/:id/stop ─────────────────────────────────────────
  // Stop an in-flight recap generation: the row ends `stopped` and the
  // change is broadcast so other clients update. No-op once the job has
  // finished.
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
