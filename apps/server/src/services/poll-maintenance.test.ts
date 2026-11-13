import { describe, expect, it } from "bun:test";
import type { Context } from "effect";
import { Effect } from "effect";
import { pullRequests } from "../db/schema/pull-requests";
import { type ObservedPr, STACK_UNSEEN } from "../domain/observed-pr";
import type { GitHubGateway } from "./github/gateway";
import type { GitHubClient } from "./github/transport";
import { openGate } from "./poll-gate";
import { backfillArchive } from "./poll-maintenance";
import { ACCOUNT_ID, makeHarness, REPO, seedDb } from "./poll-test-support";

describe("backfillArchive", () => {
  it("reads only the closed PRs the mirror doesn't hold, archived ones included, in one batch", async () => {
    const db = seedDb();
    const now = new Date().toISOString();
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
        createdAt: now,
        updatedAt: now,
        fetchedAt: now,
        closedAt: now,
      })
      .run();
    const harness = await makeHarness(db);
    const fetched: number[] = [];
    const github = {
      prs: {
        searchClosedInWindow: () =>
          Effect.succeed([
            { number: 7, closedAt: now, merged: true },
            { number: 8, closedAt: now, merged: true },
          ]),
        getMany: (
          _client: GitHubClient,
          _repo: string,
          repositoryId: string,
          numbers: readonly number[],
        ) =>
          Effect.sync(() => {
            fetched.push(...numbers);
            return new Map(
              numbers.map((n): [number, ObservedPr] => [
                n,
                {
                  id: `${repositoryId}:${n}`,
                  externalId: n,
                  repositoryId,
                  title: `PR ${n}`,
                  body: null,
                  authorLogin: "a",
                  authorAvatarContent: null,
                  authorAvatarUrl: null,
                  requestedReviewers: [],
                  mentionedUsers: [],
                  status: "merged",
                  isDraft: false,
                  sourceBranch: "f",
                  targetBranch: "main",
                  url: `https://github.test/pull/${n}`,
                  additions: 1,
                  deletions: 1,
                  changedFiles: 1,
                  headSha: "h",
                  baseSha: "b",
                  createdAt: now,
                  updatedAt: now,
                  fetchedAt: now,
                  closedAt: now,
                  stack: STACK_UNSEEN,
                },
              ]),
            );
          }),
      },
    } as unknown as Context.Service.Shape<typeof GitHubGateway>;

    const added = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* openGate(harness.accounts, new Map([[REPO.id, ACCOUNT_ID]]));
        return yield* backfillArchive(
          { github, prService: harness.prService, mirror: harness.mirror },
          gate,
          [REPO],
        );
      }),
    );

    expect(fetched).toEqual([8]);
    expect(added).toBe(true);
  });
});
