import { isOpenLayer } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { logError } from "../logger";
import { getOrFetchDiffFiles } from "../services/DiffCache";
import { PullRequestService } from "../services/PullRequest";
import { RepositoryService } from "../services/Repository";
import { StackHeadlineService } from "../services/stacks/StackHeadlines";
import { StackMergeService } from "../services/stacks/StackMerge";
import { StackRebaseService } from "../services/stacks/StackRebase";
import { StackService } from "../services/stacks/StackService";
import { runRoute, withAccount } from "./middleware";
import { ownedBy } from "./ownership";

const mergeMethod = t.Union([t.Literal("merge"), t.Literal("squash"), t.Literal("rebase")]);

export const stackRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "pull request" }))
  .get("/:id/stack", (ctx) =>
    runRoute(
      Effect.flatMap(StackService, (s) =>
        s.detail(ctx.params.id, ctx.session.user.id, ctx.account.accountId),
      ).pipe(Effect.map((stack) => ({ stack }))),
    ),
  )

  .post("/:id/stack/warm", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const stacks = yield* StackService;
        const prService = yield* PullRequestService;
        const repoService = yield* RepositoryService;
        const { accountId, accessToken } = ctx.account;

        const stack = yield* stacks.detail(ctx.params.id, ctx.session.user.id, accountId);
        const here = stack?.layers.find((l) => l.prId === ctx.params.id);
        if (!stack || !here) return { warmed: 0 };
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
            Effect.catch((err) =>
              Effect.sync(() => logError("stacks", `warming the diff of ${prId} failed`, err)),
            ),
          );

        yield* Effect.forkDetach(
          Effect.forEach(neighbours, warmOne, { concurrency: "unbounded", discard: true }),
        );
        return { warmed: neighbours.length };
      }),
    ),
  )

  .get("/:id/stack/merge-plan", (ctx) =>
    runRoute(
      Effect.flatMap(StackMergeService, (s) =>
        s.plan(ctx.params.id, ctx.session.user.id, ctx.account.accountId),
      ),
    ),
  )
  .post(
    "/:id/stack/merge",
    (ctx) =>
      runRoute(
        Effect.flatMap(StackMergeService, (s) =>
          s.start(ctx.params.id, ctx.session.user.id, ctx.account.accountId, ctx.body),
        ),
      ),
    {
      body: t.Object({
        throughPosition: t.Integer({ minimum: 1 }),
        method: mergeMethod,
        expectedHeads: t.Record(t.String(), t.String()),
      }),
    },
  )
  .post(
    "/:id/stack/rebase",
    (ctx) =>
      runRoute(
        Effect.flatMap(StackRebaseService, (s) =>
          s.rebase(
            ctx.params.id,
            ctx.session.user.id,
            ctx.account.accountId,
            ctx.body.expectedHeads,
          ),
        ),
      ),
    { body: t.Object({ expectedHeads: t.Record(t.String(), t.String()) }) },
  );

export const repoStackRoutes = new Elysia({ prefix: "/api/repos" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "repository" }))
  .get("/:id/stack-headlines", (ctx) =>
    runRoute(
      Effect.flatMap(StackHeadlineService, (s) =>
        s.forRepo(ctx.params.id, ctx.account.accountId),
      ).pipe(Effect.map((headlines) => ({ headlines }))),
    ),
  );

export const stackMergeRunRoutes = new Elysia({ prefix: "/api/stack-merges" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "stack merge" }))
  .post("/:id/cancel", (ctx) =>
    runRoute(
      Effect.flatMap(StackMergeService, (s) => s.cancel(ctx.params.id, ctx.account.accountId)),
    ),
  )
  .post("/:id/continue", (ctx) =>
    runRoute(
      Effect.flatMap(StackMergeService, (s) => s.continueRun(ctx.params.id, ctx.account.accountId)),
    ),
  );
