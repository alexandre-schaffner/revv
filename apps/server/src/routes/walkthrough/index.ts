// ── Walkthrough HTTP surface ────────────────────────────────────────────────
//
// Trigger, hydrate and lifecycle endpoints for a PR's walkthrough. Generation
// events stream over the global SSE bus (`/api/events`), not from here. The
// agent's own surface is `/mcp/walkthrough` (routes/mcp/walkthrough.ts).

import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { pullRequests, repositories } from "../../db/schema";
import { NotFoundError } from "../../domain/errors";
import { tryDb } from "../../effects/db-try";
import { PrContextService } from "../../services/PrContext";
import { WalkthroughService } from "../../services/Walkthrough";
import { WalkthroughJobs } from "../../services/WalkthroughJobs";
import { runRoute, withAccount } from "../middleware";
import { ownedBy } from "../ownership";
import { currentWalkthrough } from "./current";
import { ensureHunkScan, walkthroughSizing } from "./previews";

const perspective = t.Union([t.Literal("reviewer"), t.Literal("author")]);
const generationMode = t.Union([t.Literal("full"), t.Literal("incremental")]);
const perspectiveBody = t.Optional(t.Object({ mode: t.Optional(perspective) }));

/** Routes on a PR's walkthrough: `:id` names the pull request. */
const prWalkthroughRoutes = new Elysia({ prefix: "/api/reviews" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "pull request" }))
  .post(
    "/:id/walkthrough/start",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const jobs = yield* WalkthroughJobs;
          // `mode` is the walkthrough's perspective, the user's pick. A live
          // run at the PR's head is joined by `startJob` itself.
          const mode = ctx.body?.mode ?? "reviewer";
          return yield* jobs.startJob({
            prId: ctx.params.id,
            trigger: "user",
            mode,
            generationMode: ctx.body?.generationMode ?? "full",
          });
        }).pipe(Effect.map(({ walkthroughId }) => ({ success: true, walkthroughId }))),
      ),
    {
      body: t.Optional(
        t.Object({ mode: t.Optional(perspective), generationMode: t.Optional(generationMode) }),
      ),
    },
  )

  .get(
    "/:id/walkthrough/current",
    (ctx) => runRoute(currentWalkthrough(ctx.params.id, ctx.query.mode)),
    { query: t.Object({ mode: t.Optional(perspective) }) },
  )

  .get("/:id/walkthrough/sizing", (ctx) => runRoute(walkthroughSizing(ctx.params.id)))

  // Owned by the PR head, not a walkthrough, so the Diff tab has it before
  // Generate.
  .post("/:id/hunk-scan", (ctx) => runRoute(ensureHunkScan(ctx.params.id)))

  .get("/:id/walkthrough/rounds", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const walkthroughService = yield* WalkthroughService;
        const pr = yield* tryDb("walkthrough rounds: pull request", (db) =>
          db
            .select({ id: pullRequests.id, headSha: pullRequests.headSha })
            .from(pullRequests)
            .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
            .where(
              and(
                eq(pullRequests.id, ctx.params.id),
                eq(repositories.accountId, ctx.account.accountId),
              ),
            )
            .get(),
        );
        if (!pr) {
          return yield* Effect.fail(
            new NotFoundError({ resource: "pull_request", id: ctx.params.id }),
          );
        }
        // DB-only: the client refreshes this for every active PR on each
        // `prs:updated`, so a GitHub call here would be rate-limit pressure.
        return yield* walkthroughService.listReviewRounds(pr.id, pr.headSha);
      }),
    ),
  )

  .get("/:id/walkthrough/report/:walkthroughId", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const prContext = yield* PrContextService;
        const walkthroughService = yield* WalkthroughService;
        const { pr } = yield* prContext.forPr(ctx.params.id);
        const report = yield* walkthroughService.getReport(pr.id, ctx.params.walkthroughId);
        if (!report) return { status: "not_found" as const };
        const seqAt = yield* walkthroughService.getSeqAt(report.walkthrough.id);
        return {
          status: report.status,
          walkthrough: report.walkthrough,
          seqAt,
          stale:
            report.status === "superseded" ||
            (pr.headSha !== null && report.walkthrough.prHeadSha !== pr.headSha),
          historical: true as const,
        };
      }),
    ),
  )

  // A do-over: cancel the live job and supersede every row of the PR, in
  // every perspective and at every head — the same path PollScheduler takes
  // on a new head, minus its `exceptHeadSha`, which would spare the stopped
  // row at the current head for `createPartial` to hand back. Rows are
  // superseded, not deleted, so history survives (invariant 7). The
  // following `start` call carries the perspective and generation mode.
  .post("/:id/walkthrough/regenerate", (ctx) =>
    runRoute(
      Effect.flatMap(WalkthroughJobs, (jobs) => jobs.supersedeForPr(ctx.params.id)).pipe(
        Effect.as({ success: true }),
      ),
    ),
  )

  // Relaunch a run that died (`generating`) or stopped (`error`). An errored
  // row is revived with a fresh resume budget, so the agent picks up its
  // persisted content through `get_walkthrough_state` instead of
  // `createPartial` recycling the row. 404 when nothing is resumable — the
  // row was superseded or never created; Regenerate is the next step.
  .post(
    "/:id/walkthrough/resume",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const jobs = yield* WalkthroughJobs;
          const service = yield* WalkthroughService;
          const mode = ctx.body?.mode;
          const row = yield* service.findResumable(ctx.params.id, mode);
          if (!row) {
            return yield* Effect.fail(
              new NotFoundError({ resource: "walkthrough", id: ctx.params.id }),
            );
          }
          if (row.status === "error") yield* jobs.reviveFromError(row.id);
          const { walkthroughId } = yield* jobs.startJob({
            prId: ctx.params.id,
            trigger: "resume",
            walkthroughId: row.id,
            mode: mode ?? row.mode,
            generationMode: row.generationMode,
          });
          return { success: true, walkthroughId };
        }),
      ),
    { body: perspectiveBody },
  )

  // The Stop button: the row ends `error` with end reason `cancelled`, not
  // superseded, so Resume can revive it. A no-op when no run is live.
  .post(
    "/:id/walkthrough/abort",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const jobs = yield* WalkthroughJobs;
          const existing = yield* jobs.findActiveByPr(ctx.params.id, ctx.body?.mode ?? "reviewer");
          if (existing !== null) yield* jobs.cancel(existing.walkthroughId);
        }).pipe(Effect.as({ success: true })),
      ),
    { body: perspectiveBody },
  );

/** Account-scoped: in-flight jobs and their seq cursors, to seed the SSE client on (re)connect. */
const accountWalkthroughRoutes = new Elysia({ prefix: "/api/walkthroughs" })
  .use(withAccount)
  .get("/active", (ctx) =>
    runRoute(
      Effect.flatMap(WalkthroughService, (wts) =>
        wts.listActiveForAccount(ctx.account.accountId),
      ).pipe(Effect.map((walkthroughs) => ({ walkthroughs }))),
    ),
  );

export const walkthroughRoutes = new Elysia()
  .use(prWalkthroughRoutes)
  .use(accountWalkthroughRoutes);
