import { describe, expect, it } from "bun:test";
import type { PullRequest, Repository } from "@revv/shared";
import { Effect } from "effect";
import { createDb, type Db } from "../db/index";
import { account, user } from "../db/schema/auth";
import { pullRequests } from "../db/schema/pull-requests";
import { repositories } from "../db/schema/repositories";
import { DbService } from "./Db";
import { GitHubEtagCache } from "./GitHubEtagCache";
import { makeAccountPauses, openSyncCycle, type PollDeps } from "./poll-cycle";
import { backfillArchive } from "./poll-maintenance";
import { SettingsService } from "./Settings";

const REPO: Repository = {
  id: "repo-1",
  provider: "github",
  owner: "octo",
  name: "repo",
  fullName: "octo/repo",
  defaultBranch: "main",
  avatarUrl: null,
  addedAt: "2026-01-01T00:00:00Z",
  cloneStatus: "ready",
  clonePath: null,
  cloneError: null,
  managed: false,
  githubHost: "github.com",
};

function seed(db: Db): void {
  const now = new Date();
  db.insert(user)
    .values({ id: "user-1", name: "U", email: "u@test", createdAt: now, updatedAt: now })
    .run();
  db.insert(account)
    .values({
      id: "acc-1",
      accountId: "1",
      providerId: "github",
      userId: "user-1",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(repositories)
    .values({
      id: REPO.id,
      owner: REPO.owner,
      name: REPO.name,
      fullName: REPO.fullName,
      addedAt: REPO.addedAt,
      accountId: "acc-1",
    })
    .run();
  // Already archived by an earlier backfill.
  db.insert(pullRequests)
    .values({
      id: "repo-1:7",
      externalId: 7,
      repositoryId: REPO.id,
      title: "Merged",
      authorLogin: "a",
      status: "merged",
      sourceBranch: "f",
      targetBranch: "main",
      url: "https://github.test/pull/7",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      fetchedAt: now.toISOString(),
      closedAt: now.toISOString(),
    })
    .run();
}

describe("backfillArchive", () => {
  it("reads only the closed PRs the mirror doesn't hold, archived ones included, in one batch", async () => {
    const db = createDb(":memory:");
    seed(db);
    const fetched: number[] = [];
    const deps = {
      db,
      broadcaster: { broadcastToAccount: () => Effect.void, broadcastAll: () => Effect.void },
      tokenProvider: {
        getTokenByAccountId: () => Effect.succeed("token"),
        refreshAccountToken: () => Effect.fail(new Error("no refresh")),
        clearReauthRequired: () => Effect.void,
        markReauthRequired: () => Effect.void,
      },
      github: {
        prs: {
          searchClosedInWindow: () => Effect.succeed([{ number: 7 }, { number: 8 }]),
          getMany: (_repo: string, repositoryId: string, numbers: readonly number[]) =>
            Effect.sync(() => {
              fetched.push(...numbers);
              return new Map(
                numbers.map((n) => [
                  n,
                  { id: `${repositoryId}:${n}`, externalId: n, status: "merged" } as PullRequest,
                ]),
              );
            }),
        },
      },
      prService: { upsertPrs: () => Effect.void },
    } as unknown as PollDeps;

    await Effect.runPromise(
      Effect.gen(function* () {
        const cycle = yield* openSyncCycle(
          deps,
          makeAccountPauses(),
          ["acc-1"],
          new Map([[REPO.id, "acc-1"]]),
        );
        return yield* backfillArchive(deps, cycle, [REPO]);
      }).pipe(
        Effect.provideService(DbService, { db }),
        Effect.provideService(GitHubEtagCache, {} as never),
        Effect.provideService(SettingsService, {} as never),
      ),
    );

    expect(fetched).toEqual([8]);
  });
});
