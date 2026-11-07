// Conversation tab: whether the PR conflicts with its base branch, and the
// "Resolve with agent" run that brings it up to date (BaseConflictsService).

import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { BaseConflictsService } from "../services/base-conflicts/BaseConflicts";
import { runRoute, withAccount } from "./middleware";
import { ownedBy } from "./ownership";
import { pipeToSse, runStream } from "./sse";

export const prBaseConflictsRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "pull request" }))
  .get(
    "/:id/base-conflicts",
    (ctx) =>
      runRoute(
        Effect.flatMap(BaseConflictsService, (s) =>
          s.check({
            prId: ctx.params.id,
            accountId: ctx.account.accountId,
            force: ctx.query.force === "1",
          }),
        ),
      ),
    { query: t.Object({ force: t.Optional(t.String()) }) },
  )

  // SSE: status / conflict-files / agent progress frames, ending in one `result`.
  .post(
    "/:id/base-conflicts/resolve",
    (ctx) =>
      runStream(
        Effect.flatMap(BaseConflictsService, (s) =>
          s.resolve({
            prId: ctx.params.id,
            accountId: ctx.account.accountId,
            expectedHeadSha: ctx.body.expectedHeadSha,
          }),
        ).pipe(Effect.map(pipeToSse)),
      ),
    { body: t.Object({ expectedHeadSha: t.String({ pattern: "^[0-9a-f]{40}$" }) }) },
  );
