// Conversation tab: whether the PR conflicts with its base branch, and the
// "Resolve with agent" run that brings it up to date (BaseConflictsService).

import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { BaseConflictsService } from "../services/base-conflicts/BaseConflicts";
import { chatStreamToSSE, handleAppError, mapErrorToSSEResponse, withAccount } from "./middleware";

export const prBaseConflictsRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
  .get(
    "/:id/base-conflicts",
    async (ctx) => {
      try {
        return await AppRuntime.runPromise(
          Effect.flatMap(BaseConflictsService, (s) =>
            s.check({
              prId: ctx.params.id,
              userId: ctx.session.user.id,
              accountId: ctx.account.accountId,
              force: ctx.query.force === "1",
            }),
          ),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { query: t.Object({ force: t.Optional(t.String()) }) },
  )

  // SSE: status / conflict-files / agent progress frames, ending in one `result`.
  .post(
    "/:id/base-conflicts/resolve",
    async (ctx) => {
      try {
        const stream = await AppRuntime.runPromise(
          Effect.flatMap(BaseConflictsService, (s) =>
            s.resolve({
              prId: ctx.params.id,
              userId: ctx.session.user.id,
              accountId: ctx.account.accountId,
              expectedHeadSha: ctx.body.expectedHeadSha,
            }),
          ),
        );
        return new Response(chatStreamToSSE(stream), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } catch (e) {
        return mapErrorToSSEResponse(e);
      }
    },
    { body: t.Object({ expectedHeadSha: t.String({ pattern: "^[0-9a-f]{40}$" }) }) },
  );
