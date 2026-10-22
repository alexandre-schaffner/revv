import { afterEach, expect, it } from "bun:test";
import { Effect, Layer, Result } from "effect";
import { createDb } from "../db/index";
import { account, githubIssues, repositories, user } from "../db/schema";
import { DbService } from "./Db";
import { GitHubGatewayLive } from "./GitHub";
import { GitHubEtagCacheLive } from "./GitHubEtagCache";
import { IssuesService, IssuesServiceLive } from "./Issues";
import { SettingsServiceLive } from "./Settings";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

it("fetches issues from the repository host, excludes PRs, and stores sorted issues", async () => {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(user)
    .values({ id: "user", name: "Test", email: "test@example.com", createdAt: now, updatedAt: now })
    .run();
  db.insert(account)
    .values({
      id: "account",
      accountId: "gh",
      providerId: "github",
      userId: "user",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(repositories)
    .values({
      id: "repo",
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      addedAt: now.toISOString(),
      accountId: "account",
      githubHost: "nocturlab.ghe.com",
    })
    .run();
  const urls: string[] = [];
  const rawIssue = (number: number, assignees: { login: string }[], updatedAt: string) => ({
    number,
    node_id: `issue-${number}`,
    title: `Issue ${number}`,
    state: "open",
    user: { login: "author" },
    assignees,
    labels: [{ name: "bug", color: "ff0000" }],
    comments: 0,
    html_url: `https://nocturlab.ghe.com/acme/web/issues/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: updatedAt,
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify([
        rawIssue(1, [], "2026-02-01T00:00:00Z"),
        rawIssue(2, [{ login: "viewer" }], "2026-01-01T00:00:00Z"),
        { ...rawIssue(3, [], "2026-03-01T00:00:00Z"), pull_request: {} },
      ]),
    );
  }) as typeof fetch;
  const dbLayer = Layer.succeed(DbService, { db });
  const dependencies = Layer.mergeAll(GitHubEtagCacheLive, SettingsServiceLive).pipe(
    Layer.provide(dbLayer),
  );
  const layer = Layer.mergeAll(IssuesServiceLive, GitHubGatewayLive, dbLayer, dependencies);
  const run = (accountId: string) =>
    Effect.gen(function* () {
      const issues = yield* IssuesService;
      return yield* issues.listForRepo("repo", "viewer", accountId, "test-token");
    }).pipe(Effect.provide(layer));
  const issues = await Effect.runPromise(run("account"));
  expect(issues.map((issue) => issue.externalId)).toEqual([2, 1]);
  expect(issues[0]?.assignedToViewer).toBe(true);
  expect(urls).toHaveLength(1);
  expect(urls[0]).toStartWith("https://api.nocturlab.ghe.com/repos/acme/web/issues?");
  expect(db.select().from(githubIssues).all()).toHaveLength(2);
  expect(db.select().from(githubIssues).get()?.labels).toBe(
    '[{"name":"bug","color":"ff0000","description":null}]',
  );
  const denied = await Effect.runPromise(run("other-account").pipe(Effect.result));
  expect(Result.isFailure(denied)).toBe(true);
  expect(urls).toHaveLength(1);
});
