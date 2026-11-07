// The agent's commits on the PR's agent branch, and what the user does with
// them. A refusal answers through the error table. A push answers 200 with
// its outcome: `conflict`, `remote-changed` and `ref-exists` are results the
// UI acts on, not refusals.

import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { PrWorkspace } from "../services/workspace/PrWorkspace";
import { runRoute, withAuth } from "./middleware";
import { ownedBy } from "./ownership";
import { pipeToSse, runStream } from "./sse";

const prParams = t.Object({ prId: t.String() });
const commitParams = t.Object({ prId: t.String(), sha: t.String() });
const shasBody = t.Object({ shas: t.Array(t.String(), { minItems: 1 }) });

export const chatProposedChangesRoutes = new Elysia()
  .use(withAuth)
  .onBeforeHandle(ownedBy({ prId: "pull request" }))
  .get(
    "/api/chat/:prId/proposed-changes",
    (ctx) => runRoute(Effect.flatMap(PrWorkspace, (w) => w.proposed(ctx.params.prId))),
    { params: prParams },
  )
  .get(
    "/api/chat/:prId/proposed-changes/:sha/files",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) => w.commitFiles(ctx.params.prId, ctx.params.sha)).pipe(
          Effect.map((files) => ({ files })),
        ),
      ),
    { params: commitParams },
  )
  .post(
    "/api/chat/:prId/proposed-changes/merge-and-push",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) =>
          w.mergeAndPush({
            prId: ctx.params.prId,
            ...(ctx.body?.newBranchName !== undefined
              ? { newBranchName: ctx.body.newBranchName }
              : {}),
            ...(ctx.body?.force !== undefined ? { force: ctx.body.force } : {}),
          }),
        ),
      ),
    {
      params: prParams,
      body: t.Optional(
        t.Object({
          newBranchName: t.Optional(t.String()),
          force: t.Optional(t.Boolean()),
        }),
      ),
    },
  )
  .post(
    "/api/chat/:prId/proposed-changes/resolve-and-push",
    (ctx) =>
      runStream(
        Effect.flatMap(PrWorkspace, (w) => w.resolveAndPush(ctx.params.prId)).pipe(
          Effect.map(pipeToSse),
        ),
      ),
    { params: prParams },
  )
  .post(
    "/api/chat/:prId/proposed-changes/cherry-pick",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) =>
          w.cherryPickAndPush({
            prId: ctx.params.prId,
            shas: [ctx.body.sha],
          }),
        ),
      ),
    { params: prParams, body: t.Object({ sha: t.String() }) },
  )
  .post(
    "/api/chat/:prId/proposed-changes/batch-cherry-pick",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) =>
          w.cherryPickAndPush({
            prId: ctx.params.prId,
            shas: ctx.body.shas,
          }),
        ),
      ),
    { params: prParams, body: shasBody },
  )
  .delete(
    "/api/chat/:prId/proposed-changes/:sha",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) => w.discard(ctx.params.prId, [ctx.params.sha])).pipe(
          Effect.as({ status: "discarded" as const }),
        ),
      ),
    { params: commitParams },
  )
  .post(
    "/api/chat/:prId/proposed-changes/batch-discard",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) => w.discard(ctx.params.prId, ctx.body.shas)).pipe(
          Effect.map(({ discardedCount }) => ({ status: "discarded" as const, discardedCount })),
        ),
      ),
    { params: prParams, body: shasBody },
  )
  // The WORKTREE_BLOCKED recovery: rebase the agent's commits onto the PR's
  // new head, then advance the worktree to it.
  .post(
    "/api/chat/:prId/proposed-changes/rebase-onto",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) =>
          w.rebaseOnto(ctx.params.prId, ctx.body.oldHeadSha, ctx.body.newHeadSha),
        ).pipe(Effect.as({ status: "rebased" as const })),
      ),
    { params: prParams, body: t.Object({ oldHeadSha: t.String(), newHeadSha: t.String() }) },
  )
  .post(
    "/api/chat/:prId/proposed-changes/advance",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) => w.advance(ctx.params.prId, ctx.body.newHeadSha)).pipe(
          Effect.as({ status: "advanced" as const }),
        ),
      ),
    { params: prParams, body: t.Object({ newHeadSha: t.String() }) },
  );
