import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { logError } from "../logger";
import { ReviewService } from "../services/Review";
import { humanAuthor, viewerOnPr } from "../services/review-mode";
import { SyncService } from "../services/Sync";
import { runRoute, withAuth } from "./middleware";
import { ownedBy } from "./ownership";
import { threadMessageBody } from "./thread-message";

/** Who the signed-in user is on the thread's PR: who may edit or discard a draft, and who writes a reply. */
const viewerOnThread = (threadId: string) =>
  Effect.flatMap(ReviewService, (review) => review.getThread(threadId)).pipe(
    Effect.flatMap(({ prId }) => viewerOnPr(prId)),
  );

export const threadRoutes = new Elysia({ prefix: "/api/threads" })
  .use(withAuth)
  .onBeforeHandle(ownedBy({ id: "thread" }))
  .patch(
    "/:id",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const review = yield* ReviewService;
          const sync = yield* SyncService;
          const thread = yield* review.setStatus(ctx.params.id, ctx.body.status);
          // The local change stands when GitHub refuses it; the next pull pushes it again.
          yield* sync
            .pushStatus(ctx.params.id)
            .pipe(
              Effect.catch((e) =>
                Effect.sync(() =>
                  logError("threads", `push status of ${ctx.params.id} to GitHub:`, e),
                ),
              ),
            );
          return thread;
        }),
      ),
    {
      body: t.Object({
        status: t.Union([
          t.Literal("open"),
          t.Literal("pending_coder"),
          t.Literal("pending_reviewer"),
          t.Literal("resolved"),
          t.Literal("wont_fix"),
        ]),
      }),
    },
  )

  .post("/:id/push", (ctx) =>
    runRoute(
      Effect.flatMap(SyncService, (sync) => sync.pushThread(ctx.params.id)).pipe(
        Effect.as({ success: true }),
      ),
    ),
  )

  .delete("/:id", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const review = yield* ReviewService;
        const { login } = yield* viewerOnThread(ctx.params.id);
        yield* review.discardThread(ctx.params.id, login);
      }).pipe(Effect.as({ success: true })),
    ),
  )

  .patch(
    "/:id/messages/:messageId",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const review = yield* ReviewService;
          const { login } = yield* viewerOnThread(ctx.params.id);
          return yield* review.editDraft(ctx.params.id, ctx.params.messageId, ctx.body.body, login);
        }),
      ),
    { body: t.Object({ body: t.String() }) },
  )

  .delete("/:id/messages/:messageId", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const review = yield* ReviewService;
        const { login } = yield* viewerOnThread(ctx.params.id);
        yield* review.discardReply(ctx.params.id, ctx.params.messageId, login);
      }).pipe(Effect.as({ success: true })),
    ),
  )

  .post(
    "/:id/messages",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const review = yield* ReviewService;
          const author = humanAuthor(yield* viewerOnThread(ctx.params.id));
          const { message } = yield* review.reply(ctx.params.id, {
            ...ctx.body,
            ...author,
            messageType: "reply",
          });
          ctx.set.status = 201;
          return message;
        }),
      ),
    { body: threadMessageBody },
  );
