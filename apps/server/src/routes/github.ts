import type { Repository } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { REPO_CACHE_TTL_MS } from "../constants";
import { AppRuntime } from "../runtime";
import { GitHubService } from "../services/GitHub";
import { TokenProvider } from "../services/TokenProvider";
import { handleAppError, withAuth } from "./middleware";

/** Simple in-memory cache for the user's GitHub repos. */
let repoCache: { data: Repository[]; fetchedAt: number } | null = null;

export const githubRoutes = new Elysia({ prefix: "/api/github" })
  .use(withAuth)
  .get("/repos", async (ctx) => {
    const force = ctx.query.force === "true";

    if (
      !force &&
      repoCache &&
      Date.now() - repoCache.fetchedAt < REPO_CACHE_TTL_MS
    ) {
      return repoCache.data;
    }

    try {
      const repos = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const github = yield* GitHubService;
          const tokenProvider = yield* TokenProvider;

          const token = yield* tokenProvider.getGitHubToken(
            ctx.session.user.id,
          );
          return yield* github.listUserRepos(token);
        }),
      );

      repoCache = { data: repos, fetchedAt: Date.now() };
      return repos;
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });
