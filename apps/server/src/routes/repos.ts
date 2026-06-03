import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AppRuntime } from "../runtime";
import { CLONE_BASE_DIR, expandUserPath, pathIsUnder } from "../services/clone-policy";
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
  // The server's effective managed-clone base (`REVV_CLONE_DIR`, default
  // `~/.revv/repos`). The web add-repo flow reads this for its location
  // placeholder, resolved-path preview, and default `basePath` so the UI
  // never hardcodes a value that diverges from an operator's override.
  .get("/clone-base-dir", () => ({ path: CLONE_BASE_DIR }))
  .post(
    "/",
    async (ctx) => {
      const body = ctx.body;
      const isLink = body.mode === "link";

      if (!isLink && body.basePath !== undefined) {
        const resolvedBase = resolve(expandUserPath(body.basePath));
        const home = resolve(homedir());
        if (!pathIsUnder(resolvedBase, home)) {
          ctx.set.status = 400;
          return { error: "basePath must resolve to a directory under your home directory" };
        }
      }

      try {
        return await AppRuntime.runPromise(
          Effect.gen(function* () {
            const github = yield* GitHubGateway;
            const repoSvc = yield* RepositoryService;
            const scheduler = yield* PollScheduler;
            const cloneSvc = yield* RepoCloneService;

            const { accountId, accessToken: token } = ctx.account;
            const githubHost = ctx.account.host ?? "github.com";
            const repoData = yield* github.repos.get(body.fullName, token);
            const saved = yield* repoSvc.addRepo(
              {
                ...repoData,
                githubHost,
                managed: !isLink,
                ...(isLink ? { clonePath: body.clonePath } : {}),
              },
              accountId,
            );

            // Trigger a sync in the background
            yield* Effect.forkDaemon(scheduler.syncNow());

            if (isLink) {
              yield* cloneSvc
                .linkExisting(saved, body.clonePath, accountId)
                .pipe(Effect.catchAll(() => Effect.void));
            } else {
              // Trigger shallow clone in background — fire and forget
              yield* Effect.forkDaemon(
                cloneSvc
                  .cloneRepo(
                    saved,
                    token,
                    accountId,
                    body.basePath === undefined ? undefined : { basePath: body.basePath },
                  )
                  .pipe(
                    Effect.catchAll(() => Effect.void), // errors tracked in DB, don't fail the add
                  ),
              );
            }

            return saved;
          }),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      body: t.Union([
        t.Object({
          fullName: t.String(),
          mode: t.Optional(t.Literal("clone")),
          basePath: t.Optional(t.String()),
        }),
        t.Object({
          fullName: t.String(),
          mode: t.Literal("link"),
          clonePath: t.String(),
        }),
      ]),
    },
  )
  .post(
    "/inspect-local",
    async (ctx) => {
      const localPath = ctx.body.path;
      const githubHost = ctx.account.host ?? "github.com";
      try {
        return await AppRuntime.runPromise(
          Effect.gen(function* () {
            const cloneSvc = yield* RepoCloneService;
            return yield* cloneSvc.inspectLocal(localPath, githubHost);
          }),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ path: t.String() }) },
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

          if (repo.managed) {
            yield* Effect.forkDaemon(
              cloneSvc.cloneRepo(repo, token, accountId).pipe(Effect.catchAll(() => Effect.void)),
            );
          } else if (repo.clonePath) {
            // Linked repo: never route through `cloneRepo`. A missing path
            // would be treated as an empty managed-clone destination, flip
            // `managed: true`, and make a later removal `rm -rf` a path the
            // user owns. Revalidate / re-link the existing checkout instead.
            yield* cloneSvc
              .linkExisting(repo, repo.clonePath, accountId)
              .pipe(Effect.catchAll(() => Effect.void));
          }

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
