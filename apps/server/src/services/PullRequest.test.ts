import { describe, expect, it } from "bun:test";
import type { PullRequest } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { account, pullRequests, repositories, user } from "../db/schema";
import { DbService } from "./Db";
import { DiffCacheService, DiffCacheServiceLive } from "./DiffCache";
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

// ── upsertPrs: what the poll is allowed to overwrite ────────────────────────
//
// The poll's only source for open PRs is GitHub's list-PRs endpoint, which
// returns the "simple" PR object: no additions, deletions, or changed_files,
// and therefore zeroes after mapping. These tests pin the two columns whose
// prior values must survive that.

/** A PR as it arrives from the *list* endpoint: real metadata, zeroed stats. */
function listSourcedPr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "pr-open-alice",
    externalId: 1,
    repositoryId: REPO_ID,
    title: "updated title",
    body: null,
    authorLogin: "alice",
    authorAvatarContent: null,
    authorAvatarUrl: null,
    requestedReviewers: [],
    status: "open",
    reviewStatus: "pending",
    isDraft: false,
    sourceBranch: "feature",
    targetBranch: "main",
    url: "https://example.com",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headSha: "sha-new",
    baseSha: "base-new",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    fetchedAt: "2026-02-01T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

function runSvc<A, E>(
  db: Db,
  f: (svc: typeof PullRequestService.Service) => Effect.Effect<A, E, DbService>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* PullRequestService;
      return yield* f(svc).pipe(Effect.orDie);
    }).pipe(
      Effect.provide(PullRequestServiceLive),
      Effect.provide(Layer.succeed(DbService, { db })),
    ),
  );
}

function readRow(db: Db, id: string) {
  const row = db.select().from(pullRequests).where(eq(pullRequests.id, id)).get();
  if (!row) throw new Error(`missing row ${id}`);
  return row;
}

/**
 * Seed real diff stats the way production does — by caching a changed-file
 * list, which records the PR's size in the same transaction.
 */
function seedDiffStats(
  db: Db,
  prId: string,
  files: ReadonlyArray<{ path: string; additions: number; deletions: number }>,
): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* DiffCacheService;
      yield* svc.cacheFiles(
        prId,
        files.map((f) => ({
          path: f.path,
          oldPath: null,
          status: "modified",
          additions: f.additions,
          deletions: f.deletions,
          patch: null,
          fetchedAt: "2026-02-01T00:00:00Z",
        })),
      );
    }).pipe(Effect.provide(DiffCacheServiceLive), Effect.provide(Layer.succeed(DbService, { db }))),
  );
}

describe("upsertPrs diff stats", () => {
  it("keeps existing stats when the incoming row reports changedFiles = 0", async () => {
    const db = createDb(":memory:");
    seed(db);
    await seedDiffStats(db, "pr-open-alice", [
      { path: "a.ts", additions: 10, deletions: 3 },
      { path: "b.ts", additions: 5, deletions: 0 },
    ]);
    expect(readRow(db, "pr-open-alice").changedFiles).toBe(2);

    await runSvc(db, (svc) => svc.upsertPrs([listSourcedPr()]));

    const row = readRow(db, "pr-open-alice");
    expect(row.additions).toBe(15);
    expect(row.deletions).toBe(3);
    expect(row.changedFiles).toBe(2);
    // Everything else on the row still tracks GitHub.
    expect(row.title).toBe("updated title");
    expect(row.headSha).toBe("sha-new");
  });

  it("takes incoming stats when the source actually carried them", async () => {
    const db = createDb(":memory:");
    seed(db);
    await runSvc(db, (svc) =>
      svc.upsertPrs([listSourcedPr({ additions: 42, deletions: 7, changedFiles: 4 })]),
    );
    const row = readRow(db, "pr-open-alice");
    expect(row.additions).toBe(42);
    expect(row.deletions).toBe(7);
    expect(row.changedFiles).toBe(4);
  });

  it("allows a genuinely empty diff to be recorded on first insert", async () => {
    const db = createDb(":memory:");
    seed(db);
    await runSvc(db, (svc) =>
      svc.upsertPrs([listSourcedPr({ id: "pr-brand-new", externalId: 99 })]),
    );
    expect(readRow(db, "pr-brand-new").changedFiles).toBe(0);
  });
});

describe("upsertPrs mentioned users", () => {
  it("preserves comment-sourced mentions across a poll cycle", async () => {
    const db = createDb(":memory:");
    seed(db);
    // The comment sync harvests a mention that appears nowhere in the PR body.
    await runSvc(db, (svc) => svc.appendMentionedUsers("pr-open-alice", ["dave"]));
    expect(JSON.parse(readRow(db, "pr-open-alice").mentionedUsers ?? "[]")).toEqual(["dave"]);

    await runSvc(db, (svc) => svc.upsertPrs([listSourcedPr({ body: "cc @erin" })]));

    const mentioned = JSON.parse(readRow(db, "pr-open-alice").mentionedUsers ?? "[]") as string[];
    expect(mentioned.sort()).toEqual(["dave", "erin"]);
  });

  it("does not duplicate a login already present", async () => {
    const db = createDb(":memory:");
    seed(db);
    await runSvc(db, (svc) => svc.upsertPrs([listSourcedPr({ body: "cc @erin" })]));
    await runSvc(db, (svc) => svc.upsertPrs([listSourcedPr({ body: "cc @erin again" })]));
    expect(JSON.parse(readRow(db, "pr-open-alice").mentionedUsers ?? "[]")).toEqual(["erin"]);
  });
});
