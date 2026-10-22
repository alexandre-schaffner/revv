import { isOpenLayer } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { getOrFetchDiffFiles } from "../services/DiffCache";
import { PullRequestService } from "../services/PullRequest";
import { RepositoryService } from "../services/Repository";
import { StackHeadlineService } from "../services/stacks/StackHeadlines";
import { StackService } from "../services/stacks/StackService";
import { handleAppError, withAccount } from "./middleware";

export const stackRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
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
              Effect.catch((err) =>
                Effect.sync(() => logError("stacks", `warming the diff of ${prId} failed`, err)),
              ),
            );

          yield* Effect.forkDetach(
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
