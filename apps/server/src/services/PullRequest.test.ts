import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { account, pullRequests, repositories, user } from "../db/schema";
import { DbService } from "./Db";
import {
  type ListArchivedPrsParams,
  PullRequestService,
  PullRequestServiceLive,
} from "./PullRequest";

const ACCOUNT_ID = "acc-1";
const REPO_ID = "repo-1";

// Seed one account/repo and a spread of PRs across statuses and authors.
// closedAt values are deliberately out of insertion order so tests also
// assert the `closedAt DESC` ordering, not just membership.
function seed(db: Db): void {
  const now = new Date();
  db.insert(user)
    .values({
      id: "user-1",
      name: "Test",
      email: "test@example.com",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(account)
    .values({
      id: ACCOUNT_ID,
      accountId: "gh-1",
      providerId: "github:github.com",
      userId: "user-1",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(repositories)
    .values({
      id: REPO_ID,
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      addedAt: now.toISOString(),
      accountId: ACCOUNT_ID,
    })
    .run();

  const base = {
    repositoryId: REPO_ID,
    title: "t",
    sourceBranch: "feature",
    targetBranch: "main",
    url: "https://example.com",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
  };
  db.insert(pullRequests)
    .values([
      {
        ...base,
        id: "pr-open-alice",
        externalId: 1,
        authorLogin: "alice",
        status: "open",
        closedAt: null,
      },
      {
        ...base,
        id: "pr-closed-alice",
        externalId: 2,
        authorLogin: "alice",
        status: "closed",
        closedAt: "2026-07-03T00:00:00Z",
      },
      {
        ...base,
        id: "pr-merged-bob",
        externalId: 3,
        authorLogin: "bob",
        status: "merged",
        closedAt: "2026-07-05T00:00:00Z",
      },
      {
        ...base,
        id: "pr-closed-carol",
        externalId: 4,
        authorLogin: "carol",
        status: "closed",
        closedAt: "2026-07-01T00:00:00Z",
      },
    ])
    .run();
}

function listArchived(db: Db, params?: ListArchivedPrsParams) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* PullRequestService;
      return yield* svc.listArchivedPrs(ACCOUNT_ID, params);
    }).pipe(
      Effect.provide(PullRequestServiceLive),
      Effect.provide(Layer.succeed(DbService, { db })),
    ),
  );
}

describe("listArchivedPrs author filter", () => {
  it("returns all closed/merged PRs (never open) ordered by closedAt desc when unfiltered", async () => {
    const db = createDb(":memory:");
    seed(db);
    const { prs } = await listArchived(db);
    expect(prs.map((p) => p.id)).toEqual(["pr-merged-bob", "pr-closed-alice", "pr-closed-carol"]);
  });

  it("restricts to a single author", async () => {
    const db = createDb(":memory:");
    seed(db);
    const { prs } = await listArchived(db, { authorLogins: ["alice"] });
    expect(prs.map((p) => p.id)).toEqual(["pr-closed-alice"]);
    expect(prs.every((p) => p.authorLogin === "alice")).toBe(true);
  });

  it("restricts to multiple authors, still ordered by closedAt desc", async () => {
    const db = createDb(":memory:");
    seed(db);
    const { prs } = await listArchived(db, { authorLogins: ["alice", "bob"] });
    expect(prs.map((p) => p.id)).toEqual(["pr-merged-bob", "pr-closed-alice"]);
  });

  it("never surfaces an open PR, even when its author is in the filter", async () => {
    const db = createDb(":memory:");
    seed(db);
    const { prs } = await listArchived(db, { authorLogins: ["alice"] });
    expect(prs.some((p) => p.id === "pr-open-alice")).toBe(false);
  });

  it("returns nothing when the filtered author has no closed PRs", async () => {
    const db = createDb(":memory:");
    seed(db);
    const { prs } = await listArchived(db, { authorLogins: ["nobody"] });
    expect(prs).toEqual([]);
  });

  it("treats an empty author list as no filter", async () => {
    const db = createDb(":memory:");
    seed(db);
    const { prs } = await listArchived(db, { authorLogins: [] });
    expect(prs.map((p) => p.id)).toEqual(["pr-merged-bob", "pr-closed-alice", "pr-closed-carol"]);
  });
});
