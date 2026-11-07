import { STACK_REVIEW_SCOPES } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { StackBriefJobs } from "../services/stacks/StackBriefJobs";
import { StackReviewService } from "../services/stacks/StackReview";
import { runRoute, withAuth } from "./middleware";
import { asOwner } from "./ownership";
import { literalUnion } from "./schemas";

export const stackReviewRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAuth)
  .resolve(asOwner({ id: "pull request" }))
  .post(
    "/:id/stack/review",
    (ctx) =>
      runRoute(
        Effect.flatMap(StackReviewService, (s) =>
          s.start(ctx.params.id, ctx.owner, ctx.body.scope),
        ),
      ),
    { body: t.Object({ scope: literalUnion(STACK_REVIEW_SCOPES) }) },
  )
  .post("/:id/stack/brief", (ctx) =>
    runRoute(
      Effect.flatMap(StackBriefJobs, (jobs) => jobs.ensure(ctx.params.id, ctx.owner)).pipe(
        Effect.map((briefId) => ({ briefId })),
      ),
    ),
  );
