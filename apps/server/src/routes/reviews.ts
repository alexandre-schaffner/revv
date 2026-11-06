import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { Realtime } from "../services/Realtime";
import { ReviewService } from "../services/Review";
import { runRoute, withAccount } from "./middleware";
import { ownedBy } from "./ownership";
import { activeSessionHandler, coerceReviewMode } from "./reviews/handlers/active-session";
import { submitGithubReviewHandler } from "./reviews/handlers/github-submit";

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

  // ── GitHub submission ──────────────────────────────────────────────────
  .post(
    "/:id/github-submit",
    (ctx) => runRoute(submitGithubReviewHandler(ctx.params.id, ctx.session.user.id, ctx.body)),
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
