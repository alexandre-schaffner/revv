import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { GitHubApiError } from "../../domain/errors";
import { reposApi } from "./repos";
import { githubClient } from "./transport";

describe("large organization team lookup", () => {
  for (const dimension of ["teams", "members"] as const) {
    it(`keeps partial GraphQL teams when the ${dimension} cap requires REST and REST fails`, async () => {
      const teams = Array.from({ length: dimension === "teams" ? 100 : 1 }, (_, n) => ({
        slug: `team-${n}`,
        name: `Team ${n}`,
        members: {
          nodes: Array.from({ length: dimension === "members" ? 100 : 1 }, (_, n) => ({
            login: `member-${n}`,
          })),
        },
      }));
      let restCalls = 0;
      const api = reposApi({
        graphqlPartial: () =>
          Effect.succeed({ data: { organization: { teams: { nodes: teams } } } }),
        pages: () =>
          Effect.sync(() => restCalls++).pipe(
            Effect.andThen(
              Effect.fail(new GitHubApiError({ status: 403, cause: "REST unavailable" })),
            ),
          ),
      } as never);
      const result = await Effect.runPromise(
        api.teamsForOrg(githubClient("github.com", "token", "account"), "acme"),
      );
      expect(restCalls).toBe(1);
      expect(result).toEqual(
        teams.map((team) => ({
          slug: team.slug,
          name: team.name,
          memberLogins: team.members.nodes.map((member) => member.login),
        })),
      );
    });
  }
});
