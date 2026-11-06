// ── Proposed-changes sub-router ────────────────────────────────────────────
//
// /api/chat/:prId/proposed-changes/*: the agent's commits on the PR's agent
// branch, and what the user does with them. All of it is `PrWorkspace`; a
// refusal answers through the error table.

import { Effect } from "effect";
import { Elysia, t } from "elysia";
import type { AttemptPushResult } from "../services/workspace/PrWorkspace";
import { PrWorkspace } from "../services/workspace/PrWorkspace";
import { runRoute, withAuth } from "./middleware";
import { ownedBy } from "./ownership";
import { pipeToSse, runStream } from "./sse";

const prParams = t.Object({ prId: t.String() });
const commitParams = t.Object({ prId: t.String(), sha: t.String() });
const shasBody = t.Object({ shas: t.Array(t.String(), { minItems: 1 }) });

/** Conflict, remote-changed and ref-exists are outcomes, not errors; 409 lets the client branch on them. */
const pushResponse = (set: { status?: number | string }, result: AttemptPushResult) => {
  if (result.status !== "pushed") set.status = 409;
  return result;
};

export const chatProposedChangesRoutes = new Elysia()
  .use(withAuth)
  .onBeforeHandle(ownedBy({ prId: "pull request" }))
  .get(
    "/api/chat/:prId/proposed-changes",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) => w.proposed(ctx.params.prId, ctx.session.user.id)),
      ),
    { params: prParams },
  )
  .get(
    "/api/chat/:prId/proposed-changes/:sha/diff",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) =>
          w.commitPatch(ctx.params.prId, ctx.session.user.id, ctx.params.sha),
        ).pipe(
          Effect.map(
            (diff) =>
              new Response(diff, { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
          ),
        ),
      ),
    { params: commitParams },
  )
  .get(
    "/api/chat/:prId/proposed-changes/:sha/files",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) =>
          w.commitFiles(ctx.params.prId, ctx.session.user.id, ctx.params.sha),
        ).pipe(Effect.map((files) => ({ files }))),
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
            userId: ctx.session.user.id,
            ...(ctx.body?.newBranchName !== undefined
              ? { newBranchName: ctx.body.newBranchName }
              : {}),
            ...(ctx.body?.force !== undefined ? { force: ctx.body.force } : {}),
          }),
        ).pipe(Effect.map((result) => pushResponse(ctx.set, result))),
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
        Effect.flatMap(PrWorkspace, (w) =>
          w.resolveAndPush({ prId: ctx.params.prId, userId: ctx.session.user.id }),
        ).pipe(Effect.map(pipeToSse)),
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
            userId: ctx.session.user.id,
            shas: [ctx.body.sha],
          }),
        ).pipe(Effect.map((result) => pushResponse(ctx.set, result))),
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
            userId: ctx.session.user.id,
            shas: ctx.body.shas,
          }),
        ).pipe(Effect.map((result) => pushResponse(ctx.set, result))),
      ),
    { params: prParams, body: shasBody },
  )
  .delete(
    "/api/chat/:prId/proposed-changes/:sha",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) =>
          w.discard(ctx.params.prId, ctx.session.user.id, [ctx.params.sha]),
        ).pipe(Effect.as({ status: "discarded" as const })),
      ),
    { params: commitParams },
  )
  .post(
    "/api/chat/:prId/proposed-changes/batch-discard",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) =>
          w.discard(ctx.params.prId, ctx.session.user.id, ctx.body.shas),
        ).pipe(
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
          w.rebaseOnto(
            ctx.params.prId,
            ctx.session.user.id,
            ctx.body.oldHeadSha,
            ctx.body.newHeadSha,
          ),
        ).pipe(Effect.as({ status: "rebased" as const })),
      ),
    { params: prParams, body: t.Object({ oldHeadSha: t.String(), newHeadSha: t.String() }) },
  )
  .post(
    "/api/chat/:prId/proposed-changes/advance",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (w) =>
          w.advance(ctx.params.prId, ctx.session.user.id, ctx.body.newHeadSha),
        ).pipe(Effect.as({ status: "advanced" as const })),
      ),
    { params: prParams, body: t.Object({ newHeadSha: t.String() }) },
  );
