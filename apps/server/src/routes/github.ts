import type { Repository } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { CacheService } from "../services/Cache";
import { GitHubGateway } from "../services/GitHub";
import { runRoute, withAccount } from "./middleware";

/** TTL for the in-memory GitHub repo list cache. */
const REPO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const TEAMS_CACHE_TTL_MS = 10 * 60 * 1000;

/** Simple in-memory cache for the user's GitHub repos, keyed by resolved host. */
let repoCache: { data: Repository[]; fetchedAt: number; host: string } | null = null;

export const githubRoutes = new Elysia({ prefix: "/api/github" })
  .use(withAccount)
  .get("/repos", (ctx) => {
    const force = ctx.query.force === "true";

    return runRoute(
      Effect.gen(function* () {
        const host = ctx.account.host;

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
  })
  .post(
    "/pr-counts",
    (ctx) =>
      runRoute(
        Effect.flatMap(GitHubGateway, (github) =>
          github.repos.openPrCounts(ctx.body.fullNames, ctx.account.accessToken),
        ).pipe(Effect.map((counts) => ({ counts: Object.fromEntries(counts) }))),
      ),
    { body: t.Object({ fullNames: t.Array(t.String()) }) },
  )
  .get("/teams/:org", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        const cache = yield* CacheService;
        const token = ctx.account.accessToken;
        return yield* cache.getOrFetch(
          "github-teams",
          `${ctx.account.accountId}:${ctx.params.org.toLowerCase()}`,
          () => github.repos.teamsForOrg(ctx.params.org, token),
          { ttlMs: TEAMS_CACHE_TTL_MS },
        );
      }).pipe(Effect.map((teams) => ({ teams }))),
    ),
  );
