import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { GitHubGateway } from "../services/GitHub";
import { PollScheduler } from "../services/PollScheduler";
import { RepoCloneService } from "../services/RepoClone";
import { RepositoryService } from "../services/Repository";
import { handleAppError, withAccount } from "./middleware";

export const repoRoutes = new Elysia({ prefix: "/api/repos" })
  .use(withAccount)
  .get("/", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const repoSvc = yield* RepositoryService;

          return yield* repoSvc.listRepos(ctx.account.accountId);
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post(
    "/",
    async (ctx) => {
      const { fullName } = ctx.body;

      try {
        return await AppRuntime.runPromise(
          Effect.gen(function* () {
            const github = yield* GitHubGateway;
            const repoSvc = yield* RepositoryService;
            const scheduler = yield* PollScheduler;
            const cloneSvc = yield* RepoCloneService;

            const { accountId, accessToken: token } = ctx.account;
            const githubHost = ctx.account.host ?? "github.com";
            const repoData = yield* github.repos.get(fullName, token);
            const saved = yield* repoSvc.addRepo({ ...repoData, githubHost }, accountId);

            // Trigger a sync in the background
            yield* Effect.forkDaemon(scheduler.syncNow());

            // Trigger shallow clone in background — fire and forget
            yield* Effect.forkDaemon(
              cloneSvc.cloneRepo(saved, token, accountId).pipe(
                Effect.catchAll(() => Effect.void), // errors tracked in DB, don't fail the add
              ),
            );

            return saved;
          }),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ fullName: t.String() }) },
  )
  .get("/:id/clone-status", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const cloneSvc = yield* RepoCloneService;
          return yield* cloneSvc.getCloneStatus(ctx.params.id);
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post("/:id/retry-clone", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const repoSvc = yield* RepositoryService;
          const cloneSvc = yield* RepoCloneService;

          const { accountId, accessToken: token } = ctx.account;
          const repo = yield* repoSvc.getRepoById(ctx.params.id, accountId);

          yield* Effect.forkDaemon(
            cloneSvc.cloneRepo(repo, token, accountId).pipe(Effect.catchAll(() => Effect.void)),
          );

          return { success: true };
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .delete("/:id", async (ctx) => {
    try {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const cloneSvc = yield* RepoCloneService;
          const repoSvc = yield* RepositoryService;
          const { accountId } = ctx.account;

          // Clean up clone dir first (best effort)
          yield* cloneSvc.deleteClone(ctx.params.id).pipe(Effect.catchAll(() => Effect.void));

          // Then delete DB record (scoped to account)
          yield* repoSvc.deleteRepo(ctx.params.id, accountId);
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }

    return { success: true };
  });
