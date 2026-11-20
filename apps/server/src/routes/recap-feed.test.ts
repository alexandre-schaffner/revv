import { describe, expect, it } from "bun:test";
import { type RecapSourceScope, recapScopeCovers } from "@revv/shared";
import { Effect } from "effect";
import { GitHubGateway } from "../services/github/gateway";
import { githubClient } from "../services/github/transport";
import { PrContextService } from "../services/PrContext";
import { resolveRecapScope } from "./recap-feed";

const scope: RecapSourceScope = {
  key: "all",
  kind: "all",
  label: "Everything",
  accountId: "account",
  repositoryIds: ["repo"],
  teams: [
    { org: "acme", slug: "dev", name: "Dev", memberLogins: ["alex"], repositoryIds: ["repo"] },
  ],
};

describe("recap view coverage", () => {
  it("does not reuse a partial or older team snapshot for a missing team", () => {
    const selection = { org: "acme", team: "new-team" };
    expect(recapScopeCovers(scope, selection)).toBe(false);
    expect(recapScopeCovers({ ...scope, teams: [] }, selection)).toBe(false);
    expect(recapScopeCovers(scope, { org: "ACME", team: "DEV" })).toBe(true);
    expect(recapScopeCovers(scope, { org: "other", team: "dev" })).toBe(false);
    expect(recapScopeCovers(scope, { repoId: "new-repo" })).toBe(false);
    expect(recapScopeCovers(scope, { repoId: "repo" })).toBe(true);
  });

  it("does not fetch GitHub teams when reading a team feed or calendar month", async () => {
    let calls = 0;
    const run = (snapshot: boolean) =>
      Effect.runPromise(
        resolveRecapScope(
          "account",
          githubClient("github.com", "token", "account"),
          { org: "acme", team: "dev" },
          snapshot,
        ).pipe(
          Effect.provideService(PrContextService, {
            listReposForAccount: () =>
              Effect.succeed([{ id: "repo", owner: "acme", fullName: "acme/widget" }]),
          } as never),
          Effect.provideService(GitHubGateway, {
            repos: {
              teamsForOrg: () =>
                Effect.sync(() => {
                  calls++;
                  return [{ slug: "dev", name: "Developers", memberLogins: ["alex"] }];
                }),
            },
          } as never),
        ),
      );
    for (let month = 0; month < 3; month++) await run(false);
    expect(calls).toBe(0);
    const generated = await run(true);
    expect(calls).toBe(1);
    expect(generated.scope?.memberLogins).toEqual(["alex"]);
  });
});
