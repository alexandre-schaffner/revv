import type { Repository } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { REPO_CACHE_TTL_MS } from "../constants";
import { AppRuntime } from "../runtime";
import { GitHubGateway } from "../services/GitHub";
import { handleAppError, withAccount } from "./middleware";

/** Simple in-memory cache for the user's GitHub repos, keyed by resolved host. */
let repoCache: { data: Repository[]; fetchedAt: number; host: string } | null = null;

export const githubRoutes = new Elysia({ prefix: "/api/github" })
  .use(withAccount)
  .get("/repos", async (ctx) => {
    const force = ctx.query.force === "true";

    try {
      const repos = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const host = ctx.account.host ?? "github.com";

          if (
            !force &&
            repoCache &&
            repoCache.host === host &&
            Date.now() - repoCache.fetchedAt < REPO_CACHE_TTL_MS
          ) {
            return repoCache.data;
          }

          const github = yield* GitHubGateway;

          const token = ctx.account.accessToken;
          const fetched = yield* github.repos.listForUser(token);

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
            const github = yield* GitHubGateway;

            const token = ctx.account.accessToken;
            return yield* github.repos.openPrCounts(fullNames, token);
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
  )
  .get("/teams/:org", async (ctx) => {
    try {
      const teams = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const github = yield* GitHubGateway;
          const token = ctx.account.accessToken;
          return yield* github.repos.teamsForOrg(ctx.params.org, token);
        }),
      );
      return { teams };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });
