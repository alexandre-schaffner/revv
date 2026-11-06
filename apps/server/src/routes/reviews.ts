import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { pullRequests, repositories } from "../db/schema";
import { NotFoundError } from "../domain/errors";
import { DbService } from "../services/Db";
import { PrContextService } from "../services/PrContext";
import { Realtime } from "../services/Realtime";
import { ReviewService } from "../services/Review";
import { WalkthroughService } from "../services/Walkthrough";
import { WalkthroughJobs } from "../services/WalkthroughJobs";
import { runRoute, withAccount } from "./middleware";
import { ownedBy } from "./ownership";
import { activeSessionHandler, coerceReviewMode } from "./reviews/handlers/active-session";
import { submitGithubReviewHandler } from "./reviews/handlers/github-submit";
import { ensureHunkScanHandler } from "./reviews/handlers/hunk-scan";
import {
  coerceWalkthroughMode,
  regenerateWalkthroughHandler,
  resumeWalkthroughHandler,
} from "./reviews/handlers/walkthrough-cache";
import { getCurrentWalkthroughHandler } from "./reviews/handlers/walkthrough-current";
import { getWalkthroughSizingHandler } from "./reviews/handlers/walkthrough-sizing";

/** Routes on a review session: `:id` names the session. */
const reviewSessionRoutes = new Elysia({ prefix: "/api/reviews" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "review session" }))
  .post(
    "/:id/threads",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const reviewService = yield* ReviewService;
          const realtime = yield* Realtime;

          const thread = yield* reviewService.createThread(ctx.params.id, {
            filePath: ctx.body.filePath,
            startLine: ctx.body.startLine,
            endLine: ctx.body.endLine,
            diffSide: ctx.body.diffSide,
          });

          const message = yield* reviewService.addMessage(thread.id, {
            authorRole: ctx.body.message.authorRole,
            authorName: ctx.body.message.authorName,
            ...(ctx.body.message.authorLogin !== undefined
              ? { authorLogin: ctx.body.message.authorLogin }
              : {}),
            body: ctx.body.message.body,
            messageType: ctx.body.message.messageType,
            ...(ctx.body.message.codeSuggestion !== undefined
              ? { codeSuggestion: ctx.body.message.codeSuggestion }
              : {}),
          });

          // Auto-transition based on author role.
          const transitioned = yield* reviewService
            .transitionStatus(thread.id, ctx.body.message.authorRole)
            .pipe(Effect.catch(() => Effect.succeed(null)));

          yield* realtime.toAccount(ctx.account.accountId, {
            type: "thread:created",
            data: {
              sessionId: ctx.params.id,
              thread: transitioned ?? thread,
              message,
            },
          });

          ctx.set.status = 201;
          return { thread: transitioned ?? thread, message };
        }),
      ),
    {
      body: t.Object({
        filePath: t.String(),
        startLine: t.Number(),
        endLine: t.Number(),
        diffSide: t.Union([t.Literal("old"), t.Literal("new")]),
        message: t.Object({
          authorRole: t.Union([t.Literal("reviewer"), t.Literal("coder"), t.Literal("ai_agent")]),
          authorName: t.String(),
          authorLogin: t.Optional(t.String()),
          body: t.String(),
          messageType: t.Union([
            t.Literal("comment"),
            t.Literal("reply"),
            t.Literal("suggestion"),
            t.Literal("resolution"),
          ]),
          codeSuggestion: t.Optional(t.String()),
        }),
      }),
    },
  );

/** Routes on a PR's review: `:id` names the pull request. */
const prReviewRoutes = new Elysia({ prefix: "/api/reviews" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "pull request", prId: "pull request" }))
  .get("/active/:prId", (ctx) =>
    runRoute(activeSessionHandler(ctx.params.prId, coerceReviewMode(ctx.query.mode))),
  )

  // ── Walkthrough ────────────────────────────────────────────────────────
  //
  // Generation events stream over the global SSE bus at `/api/events`;
  // these REST endpoints handle the trigger/hydrate/lifecycle side.
  .post("/:id/walkthrough/start", (ctx) => {
    const body = ctx.body as { generationMode?: "full" | "incremental" } | undefined;
    return runRoute(
      Effect.gen(function* () {
        const jobs = yield* WalkthroughJobs;
        // `mode` is the walkthrough's perspective, which the user picks. The
        // review session is the identity-derived one; `startJob` owns it.
        const mode = coerceWalkthroughMode((ctx.body as { mode?: unknown } | undefined)?.mode);
        const existing = yield* jobs.findActiveByPr(ctx.params.id, mode);
        if (existing !== null) {
          return { walkthroughId: existing.walkthroughId };
        }
        return yield* jobs.startJob({
          prId: ctx.params.id,
          userId: ctx.session.user.id,
          trigger: "user",
          mode,
          generationMode: body?.generationMode ?? "full",
        });
      }).pipe(Effect.map(({ walkthroughId }) => ({ success: true, walkthroughId }))),
    );
  })

  .get("/:id/walkthrough/current", (ctx) =>
    // No `mode` → the server picks the perspective (see the handler).
    runRoute(
      getCurrentWalkthroughHandler(
        ctx.params.id,
        ctx.query.mode === undefined ? undefined : coerceWalkthroughMode(ctx.query.mode),
      ),
    ),
  )

  // Sizes the PR ahead of generation (risk tier, "Auto" model pick). Shares
  // its cached answer with the generation path — same TypeSafe call, moved earlier.
  .get("/:id/walkthrough/sizing", (ctx) => runRoute(getWalkthroughSizingHandler(ctx.params.id)))

  // The first pass for the PR's current head, started on first ask. Owned by
  // the PR head, not a walkthrough, so the Diff tab has it before Generate.
  .post("/:id/hunk-scan", (ctx) => runRoute(ensureHunkScanHandler(ctx.params.id)))

  .get("/:id/walkthrough/rounds", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        const walkthroughService = yield* WalkthroughService;
        const pr = db
          .select({ id: pullRequests.id, headSha: pullRequests.headSha })
          .from(pullRequests)
          .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
          .where(
            and(
              eq(pullRequests.id, ctx.params.id),
              eq(repositories.accountId, ctx.account.accountId),
            ),
          )
          .get();
        if (!pr) {
          return yield* Effect.fail(
            new NotFoundError({ resource: "pull_request", id: ctx.params.id }),
          );
        }
        // No PR context or live GitHub commit fetch here: round focus titles
        // derive from the commit list persisted per walkthrough
        // (`walkthroughs.prCommits`), so this high-frequency endpoint stays
        // DB-only. The client refreshes it for every active PR on each
        // `prs:updated`, so GitHub calls here add avoidable rate-limit pressure.
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
          status: report.status as "complete" | "generating" | "error" | "superseded",
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

  // `mode` / `generationMode` still ride along in the body — it is the
  // *start* call that consumes them. Regenerate itself sweeps every
  // perspective: only one is active per PR (see `startJobBody`).
  .post("/:id/walkthrough/regenerate", (ctx) =>
    runRoute(regenerateWalkthroughHandler(ctx.params.id).pipe(Effect.as({ success: true }))),
  )

  .post("/:id/walkthrough/resume", (ctx) => {
    const mode = (ctx.body as { mode?: unknown } | undefined)?.mode;
    return runRoute(
      resumeWalkthroughHandler(
        ctx.params.id,
        mode === undefined ? undefined : coerceWalkthroughMode(mode),
      ).pipe(Effect.map(({ walkthroughId }) => ({ success: true, walkthroughId }))),
    );
  })

  // Cancel the in-flight walkthrough for this PR (the Stop button). No-op
  // when no live job is registered (already finished / never started). The
  // orchestrator's failure handler picks up the `cancelledByUser` flag and
  // transitions the row to `status='error'` with code `'Cancelled'`, then
  // broadcasts `lifecycle:error` — that's what the UI consumes to flip out
  // of the streaming state. (That handler hangs off `Effect.onExit`, not
  // `catchAllCause`; an interrupted fiber skips the error channel entirely,
  // so the older wiring left every stopped row stuck at 'generating'.)
  // We do NOT supersede the row: a partial walkthrough should remain
  // resumable via the Resume button, which revives the 'error' row.
  .post("/:id/walkthrough/abort", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const jobs = yield* WalkthroughJobs;
        const mode = coerceWalkthroughMode((ctx.body as { mode?: unknown } | undefined)?.mode);
        const existing = yield* jobs.findActiveByPr(ctx.params.id, mode);
        if (existing !== null) {
          yield* jobs.cancel(existing.walkthroughId);
        }
      }).pipe(Effect.as({ success: true })),
    ),
  )

  // ── GitHub submission ──────────────────────────────────────────────────
  .post(
    "/:id/github-submit",
    (ctx) => runRoute(submitGithubReviewHandler(ctx.params.id, ctx.body)),
    {
      body: t.Object({
        action: t.Union([t.Literal("approve"), t.Literal("request_changes"), t.Literal("comment")]),
        body: t.Optional(t.String()),
        comments: t.Optional(
          t.Array(
            t.Object({
              path: t.String(),
              body: t.String(),
              line: t.Number(),
              side: t.Union([t.Literal("LEFT"), t.Literal("RIGHT")]),
              startLine: t.Optional(t.Number()),
              threadId: t.String(),
            }),
          ),
        ),
        issueIds: t.Optional(t.Array(t.String())),
      }),
    },
  );

/** Review routes. Non-trivial handler bodies live in `routes/reviews/handlers/*`. */
export const reviewRoutes = new Elysia().use(reviewSessionRoutes).use(prReviewRoutes);
