import { canonicalWindow } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { ValidationError } from "../domain/errors";
import { ProjectRecapService } from "../services/recaps/ProjectRecap";
import { ProjectRecapJobs } from "../services/recaps/ProjectRecapJobs";
import { errorResponse, runRoute, withAuth } from "./middleware";
import { ownedBy } from "./ownership";
import { recapStreamHandler } from "./recaps/stream";

function parsePeriod(value: string | undefined): "daily" | "weekly" | undefined {
  if (value === "daily" || value === "weekly") return value;
  return undefined;
}

const repoRecapRoutes = new Elysia({ prefix: "/api/repos" })
  .use(withAuth)
  .onBeforeHandle(ownedBy({ id: "repository" }))
  .get(
    "/:id/recaps",
    async (ctx) => {
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
      return runRoute(
        Effect.flatMap(ProjectRecapService, (s) => s.listForRepo(ctx.params.id, params)),
      );
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
  // Body: { period: "daily" | "weekly", periodStart?, periodEnd? }. Without
  // boundaries it asks for the open window so far (today / this week up to
  // now).
  .post(
    "/:id/recaps/generate",
    async (ctx) => {
      const body = ctx.body;
      const period = parsePeriod(body.period);
      if (!period) {
        return errorResponse(
          new ValidationError({ message: "period must be 'daily' or 'weekly'" }),
        );
      }
      const pinned =
        body.periodStart === undefined
          ? undefined
          : {
              periodStart: body.periodStart,
              periodEnd: body.periodEnd ?? new Date().toISOString(),
            };
      return runRoute(
        Effect.flatMap(ProjectRecapJobs, (jobs) =>
          jobs.requestRecap({
            repoId: ctx.params.id,
            period,
            ...(pinned ? { window: pinned } : {}),
            intent: "manual",
          }),
        ),
      );
    },
    {
      body: t.Object({
        period: t.String(),
        periodStart: t.Optional(t.String()),
        periodEnd: t.Optional(t.String()),
      }),
    },
  );

const recapByIdRoutes = new Elysia({ prefix: "/api/recaps" })
  .use(withAuth)
  .onBeforeHandle(ownedBy({ id: "recap" }))
  .get("/:id", (ctx) =>
    runRoute(Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id))),
  )
  // Rerun the recap over its window as it stands now: up to now while the
  // window is open, the whole period once it has closed.
  .post("/:id/regenerate", (ctx) =>
    runRoute(
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
    ),
  )
  // The row ends `stopped` and the change is broadcast so other clients
  // update. No-op once the job has finished.
  .post("/:id/stop", (ctx) =>
    runRoute(
      Effect.flatMap(ProjectRecapJobs, (jobs) => jobs.cancel(ctx.params.id)).pipe(
        Effect.as({ success: true }),
      ),
    ),
  )
  .get("/:id/stream", recapStreamHandler);

export const recapRoutes = new Elysia().use(repoRecapRoutes).use(recapByIdRoutes);
