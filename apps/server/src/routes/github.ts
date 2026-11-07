import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { CacheService } from "../services/Cache";
import { GitHubGateway } from "../services/github/gateway";
import { runRoute, withAccount } from "./middleware";

const REPO_CACHE_TTL_MS = 5 * 60 * 1000;

const TEAMS_CACHE_TTL_MS = 10 * 60 * 1000;

/** A repository the account can add, as the add-repo pickers show it. */
export interface AvailableRepo {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

export const githubRoutes = new Elysia({ prefix: "/api/github" })
  .use(withAccount)
  .get("/repos", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        const cache = yield* CacheService;
        const { accountId, client } = ctx.account;
        if (ctx.query.force === "true") yield* cache.invalidate("github-repos", accountId);
        return yield* cache.getOrFetch(
          "github-repos",
          accountId,
          () =>
            github.repos.listForUser(client).pipe(
              Effect.map((repos) =>
                repos.map(
                  (repo): AvailableRepo => ({
                    fullName: repo.fullName,
                    owner: repo.owner,
                    name: repo.name,
                    avatarUrl: repo.ownerAvatarUrl,
                  }),
                ),
              ),
            ),
          { ttlMs: REPO_CACHE_TTL_MS },
        );
      }),
    ),
  )
  .post(
    "/pr-counts",
    (ctx) =>
      runRoute(
        Effect.flatMap(GitHubGateway, (github) =>
          github.repos.openPrCounts(ctx.account.client, ctx.body.fullNames),
        ).pipe(Effect.map((counts) => ({ counts: Object.fromEntries(counts) }))),
      ),
    { body: t.Object({ fullNames: t.Array(t.String()) }) },
  )
  .get("/teams/:org", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        const cache = yield* CacheService;
        return yield* cache.getOrFetch(
          "github-teams",
          `${ctx.account.accountId}:${ctx.params.org.toLowerCase()}`,
          () => github.repos.teamsForOrg(ctx.account.client, ctx.params.org),
          { ttlMs: TEAMS_CACHE_TTL_MS },
        );
      }).pipe(Effect.map((teams) => ({ teams }))),
    ),
  );
