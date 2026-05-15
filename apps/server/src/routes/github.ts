import type { Repository } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { serverEnv } from "../config";
import { REPO_CACHE_TTL_MS } from "../constants";
import { AppRuntime } from "../runtime";
import { GitHubService } from "../services/GitHub";
import { SettingsService } from "../services/Settings";
import { TokenProvider } from "../services/TokenProvider";
import { handleAppError, withAuth } from "./middleware";

/** Simple in-memory cache for the user's GitHub repos, keyed by resolved host. */
let repoCache: { data: Repository[]; fetchedAt: number; host: string } | null = null;

export const githubRoutes = new Elysia({ prefix: "/api/github" })
  .use(withAuth)
  .get("/repos", async (ctx) => {
    const force = ctx.query.force === "true";

    try {
      const repos = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const settingsService = yield* SettingsService;
          const settings = yield* settingsService
            .getSettings()
            .pipe(Effect.orElseSucceed(() => null));
          const host = settings?.githubHost?.trim() || serverEnv.githubHost;

          if (
            !force &&
            repoCache &&
            repoCache.host === host &&
            Date.now() - repoCache.fetchedAt < REPO_CACHE_TTL_MS
          ) {
            return repoCache.data;
          }

          const github = yield* GitHubService;
          const tokenProvider = yield* TokenProvider;

          const token = yield* tokenProvider.getGitHubToken(ctx.session.user.id, host);
          const fetched = yield* github.listUserRepos(token);

          repoCache = { data: fetched, fetchedAt: Date.now(), host };
          return fetched;
        }),
      );

      return repos;
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post(
    "/pr-counts",
    async (ctx) => {
      const { fullNames } = ctx.body;

      try {
        const counts = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const settingsService = yield* SettingsService;
            const settings = yield* settingsService
              .getSettings()
              .pipe(Effect.orElseSucceed(() => null));
            const host = settings?.githubHost?.trim() || serverEnv.githubHost;

            const github = yield* GitHubService;
            const tokenProvider = yield* TokenProvider;

            const token = yield* tokenProvider.getGitHubToken(ctx.session.user.id, host);
            return yield* github.getOpenPrCounts(fullNames, token);
          }),
        );

        // Map → plain object for JSON serialization.
        const out: Record<string, number> = {};
        for (const [k, v] of counts) out[k] = v;
        return { counts: out };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ fullNames: t.Array(t.String()) }) },
  );
