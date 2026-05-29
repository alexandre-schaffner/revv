import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { db } from "../auth";
import { serverEnv } from "../config";
import { user } from "../db/schema";
import { AppRuntime } from "../runtime";
import { GitHubService } from "../services/GitHub";
import { IssuesService } from "../services/Issues";
import { PollScheduler } from "../services/PollScheduler";
import { RepoCloneService } from "../services/RepoClone";
import { RepositoryService } from "../services/Repository";
import { SettingsService } from "../services/Settings";
import { TokenProvider } from "../services/TokenProvider";
import { handleAppError, withAuth } from "./middleware";

export const repoRoutes = new Elysia({ prefix: "/api/repos" })
  .use(withAuth)
  .get("/", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const tokenProvider = yield* TokenProvider;
          const settingsSvc = yield* SettingsService;
          const repoSvc = yield* RepositoryService;

          const currentSettings = yield* settingsSvc
            .getSettings()
            .pipe(Effect.orElseSucceed(() => null));
          const githubHost = currentSettings?.githubHost?.trim() || serverEnv.githubHost;

          const { accountId } = yield* tokenProvider.resolveAccount(
            ctx.session.user.id,
            githubHost,
          );
          return yield* repoSvc.listRepos(accountId);
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
            const github = yield* GitHubService;
            const repoSvc = yield* RepositoryService;
            const scheduler = yield* PollScheduler;
            const tokenProvider = yield* TokenProvider;
            const cloneSvc = yield* RepoCloneService;
            const settingsSvc = yield* SettingsService;

            const currentSettings = yield* settingsSvc
              .getSettings()
              .pipe(Effect.orElseSucceed(() => null));
            const githubHost = currentSettings?.githubHost?.trim() || serverEnv.githubHost;

            const { accountId, accessToken: token } = yield* tokenProvider.resolveAccount(
              ctx.session.user.id,
              githubHost,
            );
            const repoData = yield* github.getRepo(fullName, token);
            const saved = yield* repoSvc.addRepo({ ...repoData, githubHost }, accountId);

            // Trigger a sync in the background
            yield* Effect.forkDaemon(scheduler.syncNow());

            // Trigger shallow clone in background — fire and forget
            yield* Effect.forkDaemon(
              cloneSvc.cloneRepo(saved, token).pipe(
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
          const tokenProvider = yield* TokenProvider;
          const cloneSvc = yield* RepoCloneService;
          const settingsSvc = yield* SettingsService;

          const currentSettings = yield* settingsSvc
            .getSettings()
            .pipe(Effect.orElseSucceed(() => null));
          const githubHost = currentSettings?.githubHost?.trim() || serverEnv.githubHost;

          const { accountId, accessToken: token } = yield* tokenProvider.resolveAccount(
            ctx.session.user.id,
            githubHost,
          );
          const repo = yield* repoSvc.getRepoById(ctx.params.id, accountId);

          yield* Effect.forkDaemon(
            cloneSvc.cloneRepo(repo, token).pipe(Effect.catchAll(() => Effect.void)),
          );

          return { success: true };
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .get("/:id/issues", async (ctx) => {
    try {
      // Look up the caller's GitHub login. Without a login we can't compute
      // the `assignedToViewer` flag — short-circuit with an empty array so
      // the homepage still renders.
      const rows = await db
        .select({ githubLogin: user.githubLogin })
        .from(user)
        .where(eq(user.id, ctx.session.user.id));
      const login = rows[0]?.githubLogin;
      if (!login) {
        return [];
      }

      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const issuesSvc = yield* IssuesService;
          const tokenProvider = yield* TokenProvider;
          const settingsSvc = yield* SettingsService;

          const currentSettings = yield* settingsSvc
            .getSettings()
            .pipe(Effect.orElseSucceed(() => null));
          const githubHost = currentSettings?.githubHost?.trim() || serverEnv.githubHost;

          const { accountId, accessToken } = yield* tokenProvider.resolveAccount(
            ctx.session.user.id,
            githubHost,
          );
          return yield* issuesSvc.listForRepo(ctx.params.id, login, accountId, accessToken);
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
          const tokenProvider = yield* TokenProvider;
          const settingsSvc = yield* SettingsService;

          const currentSettings = yield* settingsSvc
            .getSettings()
            .pipe(Effect.orElseSucceed(() => null));
          const githubHost = currentSettings?.githubHost?.trim() || serverEnv.githubHost;

          const { accountId } = yield* tokenProvider.resolveAccount(
            ctx.session.user.id,
            githubHost,
          );

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
