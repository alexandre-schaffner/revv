import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { StackBriefJobs } from "../services/stacks/StackBriefJobs";
import { StackReviewService } from "../services/stacks/StackReview";
import { runRoute, withAccount } from "./middleware";
import { ownedBy } from "./ownership";

export const stackReviewRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "pull request" }))
  .post(
    "/:id/stack/review",
    (ctx) =>
      runRoute(
        Effect.flatMap(StackReviewService, (s) =>
          s.start(ctx.params.id, ctx.userId, ctx.account.accountId, ctx.body.scope),
        ),
      ),
    { body: t.Object({ scope: t.Union([t.Literal("remaining"), t.Literal("all")]) }) },
  )
  .post("/:id/stack/brief", (ctx) =>
    runRoute(
      Effect.flatMap(StackBriefJobs, (jobs) =>
        jobs.ensure(ctx.params.id, ctx.userId, ctx.account.accountId),
      ).pipe(Effect.map((briefId) => ({ briefId }))),
    ),
  );
