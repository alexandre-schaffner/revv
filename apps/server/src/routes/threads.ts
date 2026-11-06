import { canUserModifyComment } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { ForbiddenError, NotFoundError } from "../domain/errors";
import { logError } from "../logger";
import { GitHubAccounts } from "../services/github/accounts";
import { ReviewService } from "../services/Review";
import { SyncService } from "../services/Sync";
import { runRoute, withAccount } from "./middleware";
import { ownedBy } from "./ownership";
import { threadMessageBody } from "./thread-message";

/**
 * The signed-in user's GitHub login on the account the request runs as, the
 * same identity the UI shows: who may edit, discard or publish a draft.
 */
const viewerLogin = (accountId: string) =>
  Effect.flatMap(GitHubAccounts, (accounts) => accounts.viewerLogin(accountId));

export const threadRoutes = new Elysia({ prefix: "/api/threads" })
  .use(withAccount)
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
            .pushThreadStatus(ctx.params.id)
            .pipe(
              Effect.catch((e) =>
                Effect.sync(() =>
                  logError("threads", `push status of ${ctx.params.id} to GitHub:`, e.message),
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

  // Push this thread to GitHub as a review comment.
  .post("/:id/push", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const review = yield* ReviewService;
        const [firstMessage] = yield* review.getMessages(ctx.params.id);
        if (!firstMessage) {
          return yield* Effect.fail(
            new NotFoundError({ resource: "thread message", id: ctx.params.id }),
          );
        }
        if (!canUserModifyComment(firstMessage, yield* viewerLogin(ctx.account.accountId))) {
          return yield* Effect.fail(
            new ForbiddenError({
              message: "You can only publish your own comments or comments left by Revv",
            }),
          );
        }

        const sync = yield* SyncService;
        yield* sync.pushThread(ctx.params.id);
      }).pipe(Effect.as({ success: true })),
    ),
  )

  .delete("/:id", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const review = yield* ReviewService;
        yield* review.discardThread(ctx.params.id, yield* viewerLogin(ctx.account.accountId));
      }).pipe(Effect.as({ success: true })),
    ),
  )

  .patch(
    "/:id/messages/:messageId",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const review = yield* ReviewService;
          return yield* review.editDraft(
            ctx.params.id,
            ctx.params.messageId,
            ctx.body.body,
            yield* viewerLogin(ctx.account.accountId),
          );
        }),
      ),
    { body: t.Object({ body: t.String() }) },
  )

  .post("/:id/messages/:messageId/push", (ctx) =>
    runRoute(
      Effect.flatMap(SyncService, (s) => s.pushReply(ctx.params.messageId)).pipe(
        Effect.as({ success: true }),
      ),
    ),
  )

  .delete("/:id/messages/:messageId", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const review = yield* ReviewService;
        yield* review.discardReply(
          ctx.params.id,
          ctx.params.messageId,
          yield* viewerLogin(ctx.account.accountId),
        );
      }).pipe(Effect.as({ success: true })),
    ),
  )

  .post(
    "/:id/messages",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const review = yield* ReviewService;
          const { message } = yield* review.reply(ctx.params.id, ctx.body);
          ctx.set.status = 201;
          return message;
        }),
      ),
    { body: threadMessageBody },
  );
