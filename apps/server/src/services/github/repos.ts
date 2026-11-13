import type { Team } from "@revv/shared";
import { Effect, Result } from "effect";
import type { GitHubError } from "../../domain/errors";
import { reposByName, splitFullName } from "./graphql-batch";
import { type GitHubClient, type GitHubHttp, retryTransient } from "./transport";

/** A repository as GitHub describes it, before Revv tracks it. */
export interface GitHubRepo {
  readonly githubId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  /** The owner's avatar URL. On GitHub Enterprise it is signed and expires: cache its bytes. */
  readonly ownerAvatarUrl: string | null;
}

function toGitHubRepo(raw: Record<string, unknown>): GitHubRepo {
  const owner = raw.owner as Record<string, unknown>;
  return {
    githubId: String(raw.id),
    owner: owner.login as string,
    name: raw.name as string,
    fullName: raw.full_name as string,
    defaultBranch: (raw.default_branch as string | undefined) ?? "main",
    ownerAvatarUrl: (owner.avatar_url as string | null) ?? null,
  };
}

/**
 * One installation of the GitHub App the user signed in through, as returned
 * by `repos.appInstallationsForUser`.
 */
export interface AppInstallation {
  /** Login of the org or user the app is installed on. */
  readonly accountLogin: string;
  readonly repositorySelection: "all" | "selected";
  /** The installation's settings page, where its repository access is edited. */
  readonly htmlUrl: string;
  readonly appSlug: string;
}

const COLLABORATOR_ROLES = ["admin", "maintain", "write", "triage", "read", "none"] as const;
export type CollaboratorRole = (typeof COLLABORATOR_ROLES)[number];

/**
 * A repo statistic from GitHub's `/stats/*` endpoints. GitHub computes these
 * lazily: the first request for a repo answers 202 and kicks off the job, so
 * `computing` means "ask again shortly". `unavailable` is its 422 for repos
 * too large to compute the statistic (10,000+ commits, for code frequency).
 */
export type RepoStat<T> =
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "computing" }
  | { readonly kind: "unavailable" };

export interface CommitActivityWeek {
  readonly week: number;
  readonly days: readonly number[];
}

/** One week of `/stats/code_frequency`: Sunday (Unix seconds), additions, deletions (negative). */
export type CodeFrequencyWeek = readonly [week: number, additions: number, deletions: number];

export interface PrSearchPage {
  readonly total: number;
  readonly items: ReadonlyArray<{
    readonly number: number;
    readonly authorLogin: string;
    readonly createdAt: string;
    readonly mergedAt: string | null;
  }>;
}

const orgTeamsQuery = `query OrgTeams($org: String!) {
  organization(login: $org) {
    teams(first: 100, orderBy: { field: NAME, direction: ASC }) {
      nodes {
        slug
        name
        members(first: 100) { nodes { login } }
      }
    }
  }
}`;

interface OrgTeamsResp {
  organization: {
    teams: {
      nodes: Array<{ slug: string; name: string; members: { nodes: Array<{ login: string }> } }>;
    };
  } | null;
}

export const reposApi = (http: GitHubHttp) => {
  const repoStat = <W>(
    client: GitHubClient,
    path: string,
  ): Effect.Effect<RepoStat<readonly W[]>, GitHubError> =>
    http.status(client, { path, answered: [422] }).pipe(
      Effect.map(({ status, body }): RepoStat<readonly W[]> => {
        if (status === 202) return { kind: "computing" };
        if (status === 422) return { kind: "unavailable" };
        // 204 is an empty repository.
        if (status === 204) return { kind: "ready", data: [] };
        return Array.isArray(body) ? { kind: "ready", data: body } : { kind: "computing" };
      }),
    );

  return {
    get: (client: GitHubClient, fullName: string): Effect.Effect<GitHubRepo, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        return toGitHubRepo(
          (yield* http.conditional(client, `/repos/${owner}/${repo}`)) as Record<string, unknown>,
        );
      }).pipe(retryTransient),

    /**
     * `get` without the ETag cache. GitHub Enterprise's signed `avatar_url`
     * rotates without changing the endpoint's ETag, so a 304 would replay a
     * body whose avatar URL has expired.
     */
    getFresh: (client: GitHubClient, fullName: string): Effect.Effect<GitHubRepo, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        return toGitHubRepo(
          (yield* http.json(client, { path: `/repos/${owner}/${repo}` })) as Record<
            string,
            unknown
          >,
        );
      }).pipe(retryTransient),

    listForUser: (client: GitHubClient): Effect.Effect<GitHubRepo[], GitHubError> =>
      http
        .pages(
          client,
          "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100",
          { maxPages: 3 },
        )
        .pipe(
          Effect.map((data) => (data as Record<string, unknown>[]).map(toGitHubRepo)),
          retryTransient,
        ),

    /**
     * Open PR count per repo, one aliased GraphQL request per 80 repos. A repo
     * GitHub can't resolve is absent: "unknown".
     */
    openPrCounts: (
      client: GitHubClient,
      fullNames: readonly string[],
    ): Effect.Effect<Map<string, number>, GitHubError> =>
      fullNames.length === 0
        ? Effect.succeed(new Map())
        : reposByName<{ readonly pullRequests: { readonly totalCount: number } }>(
            http,
            client,
            "OpenPrCounts",
            fullNames,
            "pullRequests(states: OPEN) { totalCount }",
          ).pipe(
            Effect.map(
              (nodes) =>
                new Map([...nodes].map(([name, node]) => [name, node.pullRequests.totalCount])),
            ),
            retryTransient,
          ),

    /**
     * Installations of the GitHub App behind a user access token. Only
     * meaningful for a token minted by a GitHub App: such a token sees a
     * repository only where the app is installed, which explains a 404 on a
     * repo the user can reach in the browser.
     */
    appInstallationsForUser: (
      client: GitHubClient,
    ): Effect.Effect<AppInstallation[], GitHubError> =>
      http.json(client, { path: "/user/installations?per_page=100" }).pipe(
        Effect.map((data) =>
          (((data ?? {}) as { installations?: Record<string, unknown>[] }).installations ?? []).map(
            (raw): AppInstallation => ({
              accountLogin: (raw.account as Record<string, unknown>).login as string,
              repositorySelection: raw.repository_selection === "all" ? "all" : "selected",
              htmlUrl: raw.html_url as string,
              appSlug: raw.app_slug as string,
            }),
          ),
        ),
        retryTransient,
      ),

    /**
     * An org's teams and their members. Needs `read:org` and org membership.
     * For an org whose teams the token can't see, GraphQL answers 200 with
     * `organization: null` and an `errors` entry; teams whose member lists all
     * come back empty are then asked of REST, keeping the GraphQL answer if
     * REST fails too.
     */
    teamsForOrg: (client: GitHubClient, org: string): Effect.Effect<Team[], GitHubError> =>
      Effect.gen(function* () {
        const fromGraphql = http.graphqlPartial<OrgTeamsResp>(client, orgTeamsQuery, { org }).pipe(
          Effect.map(({ data }) =>
            (data.organization?.teams?.nodes ?? []).map((team) => ({
              slug: team.slug,
              name: team.name,
              memberLogins: (team.members?.nodes ?? []).map((m) => m.login),
            })),
          ),
        );
        const fromRest = Effect.gen(function* () {
          const teamRows = (yield* http.pages(
            client,
            `/orgs/${encodeURIComponent(org)}/teams?per_page=100`,
            { maxPages: 5 },
          )) as Array<{ slug: string; name: string }>;
          return yield* Effect.forEach(
            teamRows,
            (team) =>
              http
                .pages(
                  client,
                  `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team.slug)}/members?per_page=100`,
                  { maxPages: 10 },
                )
                .pipe(
                  Effect.map((members) => ({
                    slug: team.slug,
                    name: team.name,
                    memberLogins: (members as Array<{ login: string }>).map((m) => m.login),
                  })),
                ),
            { concurrency: 4 },
          );
        });
        const graphqlResult = yield* Effect.result(fromGraphql);
        if (Result.isSuccess(graphqlResult)) {
          const graphqlTeams = graphqlResult.success;
          if (graphqlTeams.some((team) => team.memberLogins.length > 0)) return graphqlTeams;
          return yield* fromRest.pipe(Effect.catch(() => Effect.succeed(graphqlTeams)));
        }
        return yield* fromRest;
      }).pipe(retryTransient),

    /** A user's permission on a repo; a 404 (not a collaborator) is `none`. */
    collaboratorPermission: (
      client: GitHubClient,
      fullName: string,
      username: string,
    ): Effect.Effect<CollaboratorRole, GitHubError> =>
      http
        .status(client, {
          path: `/repos/${fullName}/collaborators/${username}/permission`,
          answered: [404],
        })
        .pipe(
          Effect.map(({ status, body }) => {
            if (status === 404) return "none" as const;
            const roleName = (body as { role_name?: string } | null)?.role_name ?? "none";
            return COLLABORATOR_ROLES.find((role) => role === roleName) ?? "none";
          }),
        ),

    commitActivity: (client: GitHubClient, fullName: string) =>
      repoStat<CommitActivityWeek>(client, `/repos/${fullName}/stats/commit_activity`),

    codeFrequency: (client: GitHubClient, fullName: string) =>
      repoStat<CodeFrequencyWeek>(client, `/repos/${fullName}/stats/code_frequency`),

    searchPullRequests: (
      client: GitHubClient,
      fullName: string,
      qualifiers: string,
    ): Effect.Effect<PrSearchPage, GitHubError> => {
      const q = `repo:${fullName} is:pr ${qualifiers}`;
      const params = new URLSearchParams({ q, per_page: "100", sort: "created", order: "desc" });
      return http.json(client, { path: `/search/issues?${params.toString()}` }).pipe(
        Effect.map((raw): PrSearchPage => {
          const body = (raw ?? {}) as { total_count?: unknown; items?: unknown };
          const items: PrSearchPage["items"][number][] = [];
          for (const entry of Array.isArray(body.items) ? body.items : []) {
            if (entry === null || typeof entry !== "object") continue;
            const item = entry as Record<string, unknown>;
            const user = item.user as Record<string, unknown> | null | undefined;
            const prMeta = item.pull_request as Record<string, unknown> | null | undefined;
            if (typeof item.number !== "number" || typeof item.created_at !== "string") continue;
            items.push({
              number: item.number,
              authorLogin: typeof user?.login === "string" ? user.login : "",
              createdAt: item.created_at,
              mergedAt: typeof prMeta?.merged_at === "string" ? prMeta.merged_at : null,
            });
          }
          const total = typeof body.total_count === "number" ? body.total_count : items.length;
          return { total, items };
        }),
        retryTransient,
      );
    },
  };
};
