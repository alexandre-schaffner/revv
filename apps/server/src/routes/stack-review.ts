// Review a whole stack: generate walkthroughs for its layers bottom-up, and
// the stack brief (the agent-written arc of the whole stack).

import type { StackReviewStarted } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { StackBriefJobs } from "../services/stacks/StackBriefJobs";
import { StackReviewService } from "../services/stacks/StackReview";
import { handleAppError, withAccount } from "./middleware";

export const stackReviewRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
  // Queue walkthroughs for the stack's open layers, bottom-up. `remaining`
  // skips layers that already have a walkthrough at their current head.
  .post(
    "/:id/stack/review",
    async (ctx): Promise<StackReviewStarted | { error: string }> => {
      try {
        return await AppRuntime.runPromise(
          Effect.flatMap(StackReviewService, (s) =>
            s.start(ctx.params.id, ctx.session.user.id, ctx.account.accountId, ctx.body.scope),
          ),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ scope: t.Union([t.Literal("remaining"), t.Literal("all")]) }) },
  )
  // Start a brief for the stack's current version, unless one exists for it.
  // Answers the brief id generating or already written, null when the PR
  // isn't stacked.
  .post(
    "/:id/stack/brief",
    async (ctx): Promise<{ briefId: string | null } | { error: string }> => {
      try {
        const briefId = await AppRuntime.runPromise(
          Effect.flatMap(StackBriefJobs, (jobs) =>
            jobs.ensure(ctx.params.id, ctx.session.user.id, ctx.account.accountId),
          ),
        );
        return { briefId };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
  );
