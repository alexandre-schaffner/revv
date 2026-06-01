import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { Broadcaster } from "../services/Broadcaster";
import { ReviewService } from "../services/Review";
import { SyncService } from "../services/Sync";
import { WalkthroughJobs } from "../services/WalkthroughJobs";
import { handleAppError, withAccount } from "./middleware";
import { activeSessionHandler } from "./reviews/handlers/active-session";
import { submitGithubReviewHandler } from "./reviews/handlers/github-submit";
import {
  getCachedWalkthroughHandler,
  regenerateWalkthroughHandler,
  resumeWalkthroughHandler,
} from "./reviews/handlers/walkthrough-cache";
import { getCurrentWalkthroughHandler } from "./reviews/handlers/walkthrough-current";

/**
 * Review routes — thin Elysia router. Handler bodies live in
 * `routes/reviews/handlers/*` to keep each file single-purpose.
 *
 * Small CRUD endpoints (threads, hunks, session lifecycle) stay inline here
 * because they're trivial Effect one-liners and extracting them adds more
 * import noise than it removes. Anything non-trivial — notably the SSE
 * walkthrough stream (formerly 370 lines inline) — lives in a handler file.
 */
export const reviewRoutes = new Elysia({ prefix: "/api/reviews" })
  .use(withAccount)

  // ── Session lifecycle ──────────────────────────────────────────────────
  .get("/active/:prId", async (ctx) => {
    try {
      return await activeSessionHandler(ctx.params.prId);
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .post(
    "/",
    async (ctx) => {
      try {
        return await AppRuntime.runPromise(
          Effect.flatMap(ReviewService, (s) => s.getOrCreateActiveSession(ctx.body.pullRequestId)),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ pullRequestId: t.String() }) },
  )

  .patch(
    "/:id",
    async (ctx) => {
      try {
        await AppRuntime.runPromise(
          Effect.flatMap(ReviewService, (s) => s.completeSession(ctx.params.id, ctx.body.status)),
        );
        return { success: true };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ status: t.Union([t.Literal("completed"), t.Literal("abandoned")]) }) },
  )

  // ── Threads ────────────────────────────────────────────────────────────
  .get(
    "/:id/threads",
    async (ctx) => {
      try {
        return await AppRuntime.runPromise(
          Effect.gen(function* () {
            const reviewService = yield* ReviewService;
            if (ctx.query.filePath) {
              return yield* reviewService.getThreadsForFile(ctx.params.id, ctx.query.filePath);
            }
            return yield* reviewService.getThreadsForSession(ctx.params.id);
          }),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { query: t.Object({ filePath: t.Optional(t.String()) }) },
  )

  .post(
    "/:id/threads",
    async (ctx) => {
      try {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const reviewService = yield* ReviewService;
            const broadcaster = yield* Broadcaster;
            // SyncService is kept as a dependency so future auto-push
            // from thread creation can be wired up without changing
            // this handler's shape.
            yield* SyncService;

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
              .pipe(Effect.catchAll(() => Effect.succeed(null)));

            yield* broadcaster.broadcastToAccount(ctx.account.accountId, {
              type: "thread:created",
              data: {
                sessionId: ctx.params.id,
                thread: transitioned ?? thread,
                message,
              },
            });

            return { thread: transitioned ?? thread, message };
          }),
        );

        ctx.set.status = 201;
        return result;
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
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
  )

  // ── Hunk decisions ─────────────────────────────────────────────────────
  .get("/:id/hunks", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(ReviewService, (s) => s.getHunkDecisions(ctx.params.id)),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .put(
    "/:id/hunks",
    async (ctx) => {
      try {
        await AppRuntime.runPromise(
          Effect.flatMap(ReviewService, (s) =>
            s.setHunkDecision(
              ctx.params.id,
              ctx.body.filePath,
              ctx.body.hunkIndex,
              ctx.body.decision,
            ),
          ),
        );
        return { success: true };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      body: t.Object({
        filePath: t.String(),
        hunkIndex: t.Number(),
        decision: t.Union([t.Literal("accepted"), t.Literal("rejected")]),
      }),
    },
  )

  .delete("/:id/hunks/:filePath/:hunkIndex", async (ctx) => {
    try {
      await AppRuntime.runPromise(
        Effect.flatMap(ReviewService, (s) =>
          s.clearHunkDecision(
            ctx.params.id,
            decodeURIComponent(ctx.params.filePath),
            Number(ctx.params.hunkIndex),
          ),
        ),
      );
      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  // ── Walkthrough ────────────────────────────────────────────────────────
  //
  // Generation events stream over the global SSE bus at `/api/events`;
  // these REST endpoints handle the trigger/hydrate/lifecycle side. The
  // legacy per-PR SSE (`GET /:id/walkthrough`) was deleted when walkthrough
  // events moved to the unified bus.
  .post("/:id/walkthrough/start", async (ctx) => {
    try {
      const result = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const jobs = yield* WalkthroughJobs;
          const existing = yield* jobs.findActiveByPr(ctx.params.id);
          if (existing !== null) {
            return { walkthroughId: existing.walkthroughId };
          }
          return yield* jobs.startJob({
            prId: ctx.params.id,
            userId: ctx.session.user.id,
            trigger: "user",
          });
        }),
      );
      return { success: true, walkthroughId: result.walkthroughId };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .get("/:id/walkthrough/current", async (ctx) => {
    try {
      return await getCurrentWalkthroughHandler(ctx.params.id, ctx.session.user.id);
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .get("/:id/walkthrough/cached", async (ctx) => {
    try {
      return await getCachedWalkthroughHandler(ctx.params.id, ctx.session.user.id);
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .post("/:id/walkthrough/regenerate", async (ctx) => {
    try {
      await regenerateWalkthroughHandler(ctx.params.id);
      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .post("/:id/walkthrough/resume", async (ctx) => {
    try {
      const result = await resumeWalkthroughHandler(ctx.params.id);
      return { success: true, walkthroughId: result.walkthroughId };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  // Cancel the in-flight walkthrough for this PR (the Stop button). No-op
  // when no live job is registered (already finished / never started). The
  // orchestrator's failure handler picks up the `cancelledByUser` flag and
  // transitions the row to `status='error'` with code `'Cancelled'`, then
  // broadcasts `lifecycle:error` — that's what the UI consumes to flip out
  // of the streaming state. We do NOT supersede the row: a partial
  // walkthrough should remain resumable via the Resume button.
  .post("/:id/walkthrough/abort", async (ctx) => {
    try {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const jobs = yield* WalkthroughJobs;
          const existing = yield* jobs.findActiveByPr(ctx.params.id);
          if (existing !== null) {
            yield* jobs.cancel(existing.walkthroughId);
          }
        }),
      );
      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  // ── GitHub submission ──────────────────────────────────────────────────
  .post(
    "/:id/github-submit",
    async (ctx) => {
      try {
        return await submitGithubReviewHandler(ctx.params.id, ctx.session.user.id, ctx.body);
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
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
