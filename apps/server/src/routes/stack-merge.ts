// Merge a stack through a chosen layer, bottom-up. The plan says what can
// merge and why not; a run is persisted and advanced against GitHub's state.

import type { StackMergePlan, StackMergeRun } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { type StackMergeError, StackMergeService } from "../services/stacks/StackMerge";
import { handleAppError, withAccount } from "./middleware";

const mergeMethod = t.Union([t.Literal("merge"), t.Literal("squash"), t.Literal("rebase")]);

/**
 * Run a stack-merge call. A refusal is the user's to read ("#122 got new
 * commits…"), so it answers 409/400 with its own message rather than going
 * through the generic error mapping.
 */
async function runMerge<A>(
  ctx: { set: { status?: number | string } },
  effect: Effect.Effect<A, StackMergeError, StackMergeService>,
): Promise<A | { error: string }> {
  try {
    const result = await AppRuntime.runPromise(
      effect.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catchTag("StackMergeRejectedError", (rejection) =>
          Effect.succeed({ ok: false as const, rejection }),
        ),
      ),
    );
    if (result.ok) return result.value;
    ctx.set.status = result.rejection.reason === "conflict" ? 409 : 400;
    return { error: result.rejection.message };
  } catch (e) {
    return handleAppError(e, ctx);
  }
}

export const stackMergeRoutes = new Elysia({ prefix: "/api" })
  .use(withAccount)
  .get(
    "/prs/:id/stack/merge-plan",
    (ctx): Promise<StackMergePlan | { error: string }> =>
      runMerge(
        ctx,
        Effect.flatMap(StackMergeService, (s) =>
          s.plan(ctx.params.id, ctx.session.user.id, ctx.account.accountId),
        ),
      ),
  )
  .post(
    "/prs/:id/stack/merge",
    (ctx): Promise<StackMergeRun | { error: string }> =>
      runMerge(
        ctx,
        Effect.flatMap(StackMergeService, (s) =>
          s.start(ctx.params.id, ctx.session.user.id, ctx.account.accountId, ctx.body),
        ),
      ),
    {
      body: t.Object({
        throughPosition: t.Integer({ minimum: 1 }),
        method: mergeMethod,
        /** Head SHAs the user saw in the sheet, by PR number; a moved layer is never merged. */
        expectedHeads: t.Record(t.String(), t.String()),
      }),
    },
  )
  .post(
    "/stack-merges/:id/cancel",
    (ctx): Promise<StackMergeRun | { error: string }> =>
      runMerge(
        ctx,
        Effect.flatMap(StackMergeService, (s) => s.cancel(ctx.params.id, ctx.account.accountId)),
      ),
  )
  .post(
    "/stack-merges/:id/continue",
    (ctx): Promise<StackMergeRun | { error: string }> =>
      runMerge(
        ctx,
        Effect.flatMap(StackMergeService, (s) =>
          s.continueRun(ctx.params.id, ctx.account.accountId),
        ),
      ),
  );
