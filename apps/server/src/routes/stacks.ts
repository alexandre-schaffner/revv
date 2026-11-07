import { isOpenLayer, MERGE_METHODS } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { logError } from "../logger";
import { DiffCacheService } from "../services/DiffCache";
import { PrContextService } from "../services/PrContext";
import { StackHeadlineService } from "../services/stacks/StackHeadlines";
import { StackMergeService } from "../services/stacks/StackMerge";
import { StackRebaseService } from "../services/stacks/StackRebase";
import { StackService } from "../services/stacks/StackService";
import { runRoute, withAuth } from "./middleware";
import { asOwner } from "./ownership";
import { literalUnion } from "./schemas";

const mergeMethod = literalUnion(MERGE_METHODS);

export const stackRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAuth)
  .resolve(asOwner({ id: "pull request" }))
  .get("/:id/stack", (ctx) =>
    runRoute(
      Effect.flatMap(StackService, (s) => s.detail(ctx.params.id, ctx.owner)).pipe(
        Effect.map((stack) => ({ stack })),
      ),
    ),
  )

  .post("/:id/stack/warm", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const stacks = yield* StackService;
        const prContext = yield* PrContextService;
        const diffCache = yield* DiffCacheService;
        const accountId = ctx.owner;

        const stack = yield* stacks.detail(ctx.params.id, accountId);
        const here = stack?.layers.find((l) => l.prId === ctx.params.id);
        if (!stack || !here) return { warmed: 0 };
        const neighbours = stack.layers.flatMap((l) =>
          l.prId !== null && Math.abs(l.position - here.position) === 1 && isOpenLayer(l)
            ? [l.prId]
            : [],
        );

        const warmOne = (prId: string) =>
          Effect.gen(function* () {
            const { pr, repo, client } = yield* prContext.forPr(prId, accountId);
            yield* diffCache.getOrFetch(pr, repo.fullName, client);
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
    runRoute(Effect.flatMap(StackMergeService, (s) => s.plan(ctx.params.id, ctx.owner))),
  )
  .post(
    "/:id/stack/merge",
    (ctx) =>
      runRoute(
        Effect.flatMap(StackMergeService, (s) => s.start(ctx.params.id, ctx.owner, ctx.body)),
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
          s.rebase(ctx.params.id, ctx.owner, ctx.body.expectedHeads),
        ),
      ),
    { body: t.Object({ expectedHeads: t.Record(t.String(), t.String()) }) },
  );

export const repoStackRoutes = new Elysia({ prefix: "/api/repos" })
  .use(withAuth)
  .resolve(asOwner({ id: "repository" }))
  .get("/:id/stack-headlines", (ctx) =>
    runRoute(
      Effect.flatMap(StackHeadlineService, (s) => s.forRepo(ctx.params.id, ctx.owner)).pipe(
        Effect.map((headlines) => ({ headlines })),
      ),
    ),
  );

export const stackMergeRunRoutes = new Elysia({ prefix: "/api/stack-merges" })
  .use(withAuth)
  .resolve(asOwner({ id: "stack merge" }))
  .post("/:id/cancel", (ctx) =>
    runRoute(Effect.flatMap(StackMergeService, (s) => s.cancel(ctx.params.id, ctx.owner))),
  )
  .post("/:id/continue", (ctx) =>
    runRoute(Effect.flatMap(StackMergeService, (s) => s.continueRun(ctx.params.id, ctx.owner))),
  );
