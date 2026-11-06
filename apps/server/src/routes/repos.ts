import { homedir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { NotFoundError, ValidationError } from "../domain/errors";
import { CLONE_BASE_DIR, expandUserPath, pathIsUnder } from "../services/clone-policy";
import { GitHubAccounts } from "../services/github/accounts";
import { GitHubGateway } from "../services/github/gateway";
import { PollScheduler } from "../services/PollScheduler";
import { getRepoActivityResponse } from "../services/RepoActivity";
import { RepoCloneService } from "../services/RepoClone";
import { RepositoryService } from "../services/Repository";
import { diagnoseRepoNotFound } from "../services/repo-access";
import { errorResponse, runRoute, withAccount } from "./middleware";
import { ownedBy } from "./ownership";

export const repoRoutes = new Elysia({ prefix: "/api/repos" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "repository" }))
  .get("/", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const repoSvc = yield* RepositoryService;

        return yield* repoSvc.listRepos(ctx.account.accountId);
      }),
    ),
  )
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
          return errorResponse(
            new ValidationError({
              message: "basePath must resolve to a directory under your home directory",
            }),
          );
        }
      }

      return runRoute(
        Effect.gen(function* () {
          const github = yield* GitHubGateway;
          const repoSvc = yield* RepositoryService;
          const scheduler = yield* PollScheduler;
          const cloneSvc = yield* RepoCloneService;

          const { accountId, client } = ctx.account;
          const token = client.token;
          const repoData = yield* github.repos
            .get(client, body.fullName)
            .pipe(
              Effect.catchTag("GitHubNotFoundError", () =>
                Effect.flatMap(
                  diagnoseRepoNotFound(body.fullName, ctx.account.client),
                  Effect.fail,
                ),
              ),
            );
          const saved = yield* repoSvc.addRepo(
            {
              provider: "github",
              owner: repoData.owner,
              name: repoData.name,
              fullName: repoData.fullName,
              defaultBranch: repoData.defaultBranch,
              avatarUrl: repoData.ownerAvatarUrl,
              githubHost: client.host,
              managed: !isLink,
              ...(isLink ? { clonePath: body.clonePath } : {}),
            },
            accountId,
          );

          // Trigger a sync in the background
          yield* Effect.forkDetach(scheduler.syncNow());

          if (isLink) {
            yield* cloneSvc
              .linkExisting(saved, body.clonePath, accountId)
              .pipe(Effect.catch(() => Effect.void));
          } else {
            // Trigger shallow clone in background — fire and forget
            yield* Effect.forkDetach(
              cloneSvc
                .cloneRepo(
                  saved,
                  token,
                  accountId,
                  body.basePath === undefined ? undefined : { basePath: body.basePath },
                )
                .pipe(
                  Effect.catch(() => Effect.void), // errors tracked in DB, don't fail the add
                ),
            );
          }

          return saved;
        }),
      );
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
      const githubHost = ctx.account.host;
      return runRoute(
        Effect.gen(function* () {
          const cloneSvc = yield* RepoCloneService;
          return yield* cloneSvc.inspectLocal(localPath, githubHost);
        }),
      );
    },
    { body: t.Object({ path: t.String() }) },
  )
  .get("/:id/clone-status", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const cloneSvc = yield* RepoCloneService;
        return yield* cloneSvc.getCloneStatus(ctx.params.id);
      }),
    ),
  )
  .get("/:id/activity", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const repoSvc = yield* RepositoryService;
        const accounts = yield* GitHubAccounts;
        const repo = yield* repoSvc.getRepoById(ctx.params.id);
        const owner = yield* repoSvc.getAccountIdForRepo(repo.id);
        const account = yield* accounts.accountForUser(ctx.session.user.id, repo.githubHost);
        if (account.accountId !== owner) {
          return yield* Effect.fail(new NotFoundError({ resource: "repository", id: repo.id }));
        }
        return yield* getRepoActivityResponse(repo, account.client);
      }),
    ),
  )
  .post("/:id/retry-clone", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const repoSvc = yield* RepositoryService;
        const cloneSvc = yield* RepoCloneService;

        const { accountId, client } = ctx.account;
        const repo = yield* repoSvc.getRepoById(ctx.params.id, accountId);

        if (repo.managed) {
          yield* Effect.forkDetach(
            cloneSvc.cloneRepo(repo, client.token, accountId).pipe(Effect.catch(() => Effect.void)),
          );
        } else if (repo.clonePath) {
          // Linked repo: never route through `cloneRepo`. A missing path
          // would be treated as an empty managed-clone destination, flip
          // `managed: true`, and make a later removal `rm -rf` a path the
          // user owns. Revalidate / re-link the existing checkout instead.
          yield* cloneSvc
            .linkExisting(repo, repo.clonePath, accountId)
            .pipe(Effect.catch(() => Effect.void));
        }

        return { success: true };
      }),
    ),
  )
  .delete("/:id", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const cloneSvc = yield* RepoCloneService;
        const repoSvc = yield* RepositoryService;
        const { accountId } = ctx.account;
        // The account check comes first: it is what keeps the clone of a
        // repository this account doesn't own on disk.
        yield* repoSvc.getRepoById(ctx.params.id, accountId);
        yield* cloneSvc.deleteClone(ctx.params.id).pipe(Effect.catch(() => Effect.void));
        yield* repoSvc.deleteRepo(ctx.params.id, accountId);
        return { success: true };
      }),
    ),
  );
