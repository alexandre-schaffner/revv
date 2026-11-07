// Trigger, hydrate and lifecycle endpoints for a PR's walkthrough. Generation
// events stream over the global SSE bus (`/api/events`), not from here. The
// agent's own surface is `/mcp/walkthrough` (routes/mcp/walkthrough.ts).

import { REVIEW_MODES, WALKTHROUGH_GENERATION_MODES } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { pullRequests } from "../../db/schema";
import { NotFoundError } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { DbService } from "../../services/Db";
import { PrContextService } from "../../services/PrContext";
import { WalkthroughService } from "../../services/walkthrough/Walkthrough";
import { WalkthroughJobs } from "../../services/walkthrough/WalkthroughJobs";
import { runRoute, withAuth } from "../middleware";
import { ownedBy } from "../ownership";
import { literalUnion } from "../schemas";
import { currentWalkthrough } from "./current";
import { ensureHunkScan, walkthroughSizing } from "./previews";

const perspective = literalUnion(REVIEW_MODES);
const generationMode = literalUnion(WALKTHROUGH_GENERATION_MODES);
const perspectiveBody = t.Optional(t.Object({ mode: t.Optional(perspective) }));

/** Routes on a PR's walkthrough: `:id` names the pull request. */
const prWalkthroughRoutes = new Elysia({ prefix: "/api/reviews" })
  .use(withAuth)
  .onBeforeHandle(ownedBy({ id: "pull request" }))
  .post(
    "/:id/walkthrough/start",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const jobs = yield* WalkthroughJobs;
          // `mode` is the walkthrough's perspective, the user's pick. A live
          // run at the PR's head is joined by `startJob` itself, unless the
          // user asked to start over (`fresh`: Regenerate).
          return yield* jobs.startJob({
            prId: ctx.params.id,
            trigger: "user",
            replace: ctx.body?.fresh === true ? "all" : "finished",
            mode: ctx.body?.mode ?? "reviewer",
            generationMode: ctx.body?.generationMode ?? "full",
          });
        }).pipe(Effect.map(({ walkthroughId }) => ({ success: true, walkthroughId }))),
      ),
    {
      body: t.Optional(
        t.Object({
          mode: t.Optional(perspective),
          generationMode: t.Optional(generationMode),
          fresh: t.Optional(t.Boolean()),
        }),
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
        const pr = yield* Effect.flatMap(DbService, ({ db }) =>
          dbTry("walkthrough rounds: pull request", () =>
            db
              .select({ id: pullRequests.id, headSha: pullRequests.headSha })
              .from(pullRequests)
              .where(eq(pullRequests.id, ctx.params.id))
              .get(),
          ),
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

  // Retire every review of the PR, in every perspective and at every head,
  // without starting another: a pulled commit makes them describe an older
  // head. Rows are superseded, not deleted, so history survives (invariant 7).
  .post("/:id/walkthrough/supersede", (ctx) =>
    runRoute(
      Effect.flatMap(WalkthroughJobs, (jobs) => jobs.supersedeForPr(ctx.params.id)).pipe(
        Effect.as({ success: true }),
      ),
    ),
  )

  // Relaunch a run that died (`generating`) or stopped (`error`) from its
  // journal, its content kept. 404 when nothing is resumable — the row was
  // superseded, the PR moved past its head, or it never existed; a new
  // review is the next step.
  .post(
    "/:id/walkthrough/resume",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const jobs = yield* WalkthroughJobs;
          const service = yield* WalkthroughService;
          const row = yield* service.findResumable(ctx.params.id, ctx.body?.mode);
          const outcome = row ? yield* jobs.resume(row.id) : "gone";
          if (!row || outcome !== "resumed") {
            return yield* Effect.fail(
              new NotFoundError({ resource: "walkthrough", id: ctx.params.id }),
            );
          }
          return { success: true, walkthroughId: row.id };
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

/** The user's in-flight jobs on every account and their seq cursors, to seed the SSE client on (re)connect. */
const userWalkthroughRoutes = new Elysia({ prefix: "/api/walkthroughs" })
  .use(withAuth)
  .get("/active", (ctx) =>
    runRoute(
      Effect.flatMap(WalkthroughService, (wts) => wts.listActiveForUser(ctx.userId)).pipe(
        Effect.map((walkthroughs) => ({ walkthroughs })),
      ),
    ),
  );

export const walkthroughRoutes = new Elysia().use(prWalkthroughRoutes).use(userWalkthroughRoutes);
