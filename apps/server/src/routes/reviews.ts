import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { ReviewService } from "../services/Review";
import { humanAuthor, viewerOnPr } from "../services/review-mode";
import { submitReview } from "../services/review-submit";
import { runRoute, withAccount } from "./middleware";
import { ownedBy } from "./ownership";
import { threadMessageBody } from "./thread-message";

/** Review routes: `:id` and `:prId` name the pull request. */
export const reviewRoutes = new Elysia({ prefix: "/api/reviews" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "pull request", prId: "pull request" }))
  // Every thread on the PR with its messages, for a cold render in one round trip.
  .get("/active/:prId", (ctx) =>
    runRoute(Effect.flatMap(ReviewService, (review) => review.getConversation(ctx.params.prId))),
  )
  .post(
    "/:id/threads",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const review = yield* ReviewService;
          const { message, ...anchor } = ctx.body;
          const author = humanAuthor(yield* viewerOnPr(ctx.params.id));
          const created = yield* review.startThread(ctx.params.id, anchor, {
            ...message,
            ...author,
          });
          ctx.set.status = 201;
          return created;
        }),
      ),
    {
      body: t.Object({
        filePath: t.String(),
        startLine: t.Number(),
        endLine: t.Number(),
        diffSide: t.Union([t.Literal("old"), t.Literal("new")]),
        message: threadMessageBody,
      }),
    },
  )

  .post("/:id/github-submit", (ctx) => runRoute(submitReview(ctx.params.id, ctx.body)), {
    body: t.Object({
      action: t.Union([t.Literal("approve"), t.Literal("request_changes"), t.Literal("comment")]),
      threadIds: t.Optional(t.Array(t.String())),
      issueIds: t.Optional(t.Array(t.String())),
    }),
  });
