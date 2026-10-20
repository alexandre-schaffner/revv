// GitHub PR stacks: the stack a PR sits in, with Revv's per-layer state, and
// the flows that act on a whole stack (review it, merge it, rebase it, brief
// it). A merge or rebase Revv refuses answers with the refusal's own message
// (`StackRejectedError`, mapped in `handleAppError`).

import {
  isOpenLayer,
  type StackMergePlan,
  type StackMergeRun,
  type StackRebaseResult,
} from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { getOrFetchDiffFiles } from "../services/DiffCache";
import { PullRequestService } from "../services/PullRequest";
import { RepositoryService } from "../services/Repository";
import { StackHeadlineService } from "../services/stacks/StackHeadlines";
import { StackMergeService } from "../services/stacks/StackMerge";
import { StackRebaseService } from "../services/stacks/StackRebase";
import { StackService } from "../services/stacks/StackService";
import { handleAppError, withAccount } from "./middleware";

export const stackRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
  // The stack this PR sits in, or `{ stack: null }` when it isn't stacked.
  .get("/:id/stack", async (ctx) => {
    try {
      const stack = await AppRuntime.runPromise(
        Effect.flatMap(StackService, (s) =>
          s.detail(ctx.params.id, ctx.session.user.id, ctx.account.accountId),
        ),
      );
      return { stack };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  // Warm the server's diff cache for the layers either side of this one, so
  // moving through the stack never waits on GitHub. Fire-and-forget.
  //
  // Answers as soon as it knows which layers to warm; the fetches run in a
  // daemon fiber, so a slow GitHub costs the caller nothing and a failure is
  // a cold diff later, never an error now. Merged and closed layers are left
  // alone: nobody moves to them to review.
  .post("/:id/stack/warm", async (ctx): Promise<{ warmed: number } | { error: string }> => {
    try {
      const warmed = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const stacks = yield* StackService;
          const prService = yield* PullRequestService;
          const repoService = yield* RepositoryService;
          const { accountId, accessToken } = ctx.account;

          const stack = yield* stacks.detail(ctx.params.id, ctx.session.user.id, accountId);
          const here = stack?.layers.find((l) => l.prId === ctx.params.id);
          if (!stack || !here) return 0;
          const neighbours = stack.layers.flatMap((l) =>
            l.prId !== null && Math.abs(l.position - here.position) === 1 && isOpenLayer(l)
              ? [l.prId]
              : [],
          );

          const warmOne = (prId: string) =>
            Effect.gen(function* () {
              const pr = yield* prService.getPr(prId, accountId);
              const repo = yield* repoService.getRepoById(pr.repositoryId, accountId);
              yield* getOrFetchDiffFiles(
                pr.id,
                repo.fullName,
                pr.externalId,
                accessToken,
                pr.changedFiles,
              );
            }).pipe(
              Effect.catchAll((err) =>
                Effect.sync(() => logError("stacks", `warming the diff of ${prId} failed`, err)),
              ),
            );

          yield* Effect.forkDaemon(
            Effect.forEach(neighbours, warmOne, { concurrency: "unbounded", discard: true }),
          );
          return neighbours.length;
        }),
      );
      return { warmed };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });

/** What each stack of a repo's open PRs builds, for the homepage queue. DB-only. */
export const repoStackRoutes = new Elysia({ prefix: "/api/repos" })
  .use(withAccount)
  .get("/:id/stack-headlines", async (ctx) => {
    try {
      const headlines = await AppRuntime.runPromise(
        Effect.flatMap(StackHeadlineService, (s) =>
          s.forRepo(ctx.params.id, ctx.account.accountId),
        ),
      );
      return { headlines };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });

type Rejection = ReturnType<typeof handleAppError>;

const mergeMethod = t.Union([t.Literal("merge"), t.Literal("squash"), t.Literal("rebase")]);

/**
 * Merge a stack through a chosen layer, bottom-up. The plan says what can
 * merge and why not; a run is persisted and advanced against GitHub's state.
 */
export const stackMergeRoutes = new Elysia({ prefix: "/api" })
  .use(withAccount)
  .get("/prs/:id/stack/merge-plan", async (ctx): Promise<StackMergePlan | Rejection> => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(StackMergeService, (s) =>
          s.plan(ctx.params.id, ctx.session.user.id, ctx.account.accountId),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post(
    "/prs/:id/stack/merge",
    async (ctx): Promise<StackMergeRun | Rejection> => {
      try {
        return await AppRuntime.runPromise(
          Effect.flatMap(StackMergeService, (s) =>
            s.start(ctx.params.id, ctx.session.user.id, ctx.account.accountId, ctx.body),
          ),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      body: t.Object({
        throughPosition: t.Integer({ minimum: 1 }),
        method: mergeMethod,
        /** Head SHAs the user saw in the sheet, by PR number; a moved layer is never merged. */
        expectedHeads: t.Record(t.String(), t.String()),
      }),
    },
  )
  .post("/stack-merges/:id/cancel", async (ctx): Promise<StackMergeRun | Rejection> => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(StackMergeService, (s) => s.cancel(ctx.params.id, ctx.account.accountId)),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post("/stack-merges/:id/continue", async (ctx): Promise<StackMergeRun | Rejection> => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(StackMergeService, (s) =>
          s.continueRun(ctx.params.id, ctx.account.accountId),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });

/**
 * Rebase a stack: every open layer back on top of the one below it, the way
 * GitHub's "Rebase stack" button does it, run in Revv's clone and pushed in
 * one atomic, leased push.
 */
export const stackRebaseRoutes = new Elysia({ prefix: "/api" }).use(withAccount).post(
  "/prs/:id/stack/rebase",
  async (ctx): Promise<StackRebaseResult | Rejection> => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(StackRebaseService, (s) =>
          s.rebase(
            ctx.params.id,
            ctx.session.user.id,
            ctx.account.accountId,
            ctx.body.expectedHeads,
          ),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  },
  {
    body: t.Object({
      /** Head SHAs the user saw, by PR number; a layer that moved since is never rebased. */
      expectedHeads: t.Record(t.String(), t.String()),
    }),
  },
);
