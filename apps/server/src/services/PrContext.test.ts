import { describe, expect, it } from "bun:test";
import type { PullRequest } from "@revv/shared";
import { type Context, Effect, Layer } from "effect";
import { pullRequests } from "../db/schema";
import { DbService } from "./Db";
import { DiffCacheService } from "./DiffCache";
import { GitHubAccounts } from "./github/accounts";
import { GitHubGateway } from "./github/gateway";
import type { PrFileMeta } from "./github/pulls";
import { githubClient } from "./github/transport";
import { PrContextService, PrContextServiceLive } from "./PrContext";
import { PullRequestServiceLive } from "./PullRequest";
import { ACCOUNT_ID, seedDb } from "./poll-test-support";
import { RepositoryServiceLive } from "./Repository";

const STORED = {
  id: "repo-1:7",
  externalId: 7,
  repositoryId: "repo-1",
  title: "Old title",
  authorLogin: "author",
  sourceBranch: "feature",
  targetBranch: "main",
  url: "https://github.test/pull/7",
  headSha: "old-head",
  baseSha: "base",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  fetchedAt: "2026-01-01T00:00:00Z",
};

const fileMeta = (filename: string): PrFileMeta =>
  ({ filename, status: "modified", additions: 1, deletions: 0, patch: null }) as PrFileMeta;

async function withDiff(live: { headSha: string; title: string }) {
  const db = seedDb();
  db.insert(pullRequests).values(STORED).run();
  const fetched: string[] = [];
  const github = {
    prs: {
      get: () =>
        Effect.succeed({ ...STORED, ...live, body: "live body" } as unknown as PullRequest),
      files: () =>
        Effect.sync(() => {
          fetched.push("github");
          return [fileMeta("new.ts")];
        }),
      commits: () => Effect.succeed([]),
    },
  };
  const diffCache = {
    getOrFetch: () =>
      Effect.sync(() => {
        fetched.push("cache");
        return {
          files: [
            {
              path: "old.ts",
              oldPath: null,
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: null,
              fetchedAt: "",
            },
          ],
          source: "cache" as const,
        };
      }),
  };
  const dbLayer = Layer.succeed(DbService, { db });
  const layer = PrContextServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        dbLayer,
        PullRequestServiceLive,
        RepositoryServiceLive,
        Layer.succeed(GitHubAccounts, {
          clientFor: () => Effect.succeed(githubClient("github.com", "tok", ACCOUNT_ID)),
        } as unknown as Context.Service.Shape<typeof GitHubAccounts>),
        Layer.succeed(
          GitHubGateway,
          github as unknown as Context.Service.Shape<typeof GitHubGateway>,
        ),
        Layer.succeed(
          DiffCacheService,
          diffCache as unknown as Context.Service.Shape<typeof DiffCacheService>,
        ),
      ),
    ),
  );
  const ctx = await Effect.runPromise(
    Effect.flatMap(PrContextService, (s) => s.withDiff(STORED.id)).pipe(Effect.provide(layer)),
  );
  return { ctx, fetched };
}

describe("PrContextService.withDiff", () => {
  it("serves the cached files while the stored head is GitHub's", async () => {
    const { ctx, fetched } = await withDiff({ headSha: "old-head", title: "Old title" });
    expect(fetched).toEqual(["cache"]);
    expect(ctx.files.map((f) => f.filename)).toEqual(["old.ts"]);
  });

  it("reads a head GitHub reports before the poll recorded it from GitHub, not the stale cache", async () => {
    const { ctx, fetched } = await withDiff({ headSha: "new-head", title: "New title" });
    expect(fetched).toEqual(["github"]);
    expect(ctx.files.map((f) => f.filename)).toEqual(["new.ts"]);
    expect(ctx.meta.headSha).toBe("new-head");
    expect(ctx.pr).toMatchObject({ headSha: "new-head", title: "New title", body: "live body" });
  });
});
