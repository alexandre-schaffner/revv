import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { account, pullRequests, repositories, user } from "../db/schema";
import { type ObservedPr, STACK_UNSEEN, stackSeen } from "../domain/observed-pr";
import { DbService } from "./Db";
import { DiffCacheService, DiffCacheServiceLive } from "./DiffCache";
import { GitHubGateway, GitHubGatewayLive } from "./GitHub";
import { GitHubEtagCacheLive } from "./GitHubEtagCache";
import {
  type ListArchivedPrsParams,
  PullRequestService,
  PullRequestServiceLive,
} from "./PullRequest";
import { SettingsServiceLive } from "./Settings";

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
function listSourcedPr(overrides: Partial<ObservedPr> = {}): ObservedPr {
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
    mentionedUsers: [],
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
    stack: STACK_UNSEEN,
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
        readRow(db, prId),
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

// ── listOpenPrsAsOfWindow: "in flight" reconstructed from timestamps ────────
//
// The `status` column only ever describes *now*, so a recap for a window three
// weeks back must decide membership from createdAt/closedAt instead. These
// pin the four corners of that predicate.

const WINDOW_END = "2026-07-04T00:00:00Z";

function seedInFlight(db: Db): void {
  const base = {
    repositoryId: REPO_ID,
    title: "t",
    authorLogin: "alice",
    sourceBranch: "feature",
    targetBranch: "main",
    url: "https://example.com",
    updatedAt: "2026-07-01T00:00:00Z",
    fetchedAt: "2026-07-01T00:00:00Z",
  };
  db.insert(pullRequests)
    .values([
      // Opened before the window closed, still open today.
      {
        ...base,
        id: "pr-still-open",
        externalId: 10,
        status: "open",
        createdAt: "2026-06-20T00:00:00Z",
        closedAt: null,
      },
      // Opened before, closed *after* — in flight at that instant.
      {
        ...base,
        id: "pr-closed-after",
        externalId: 11,
        status: "merged",
        createdAt: "2026-06-20T00:00:00Z",
        closedAt: "2026-07-10T00:00:00Z",
      },
      // Opened before, closed *before* — already done by then.
      {
        ...base,
        id: "pr-closed-before",
        externalId: 12,
        status: "merged",
        createdAt: "2026-06-20T00:00:00Z",
        closedAt: "2026-07-02T00:00:00Z",
      },
      // Didn't exist yet.
      {
        ...base,
        id: "pr-created-after",
        externalId: 13,
        status: "open",
        createdAt: "2026-07-20T00:00:00Z",
        closedAt: null,
      },
    ])
    .run();
}

function listInFlight(db: Db, until: string) {
  return runSvc(db, (svc) => svc.listOpenPrsAsOfWindow(REPO_ID, until));
}

describe("listOpenPrsAsOfWindow", () => {
  it("includes a PR opened before the window that is still open", async () => {
    const db = createDb(":memory:");
    seed(db);
    seedInFlight(db);
    const ids = (await listInFlight(db, WINDOW_END)).map((r) => r.pr.id);
    expect(ids).toContain("pr-still-open");
  });

  it("includes a PR that closed after the window", async () => {
    const db = createDb(":memory:");
    seed(db);
    seedInFlight(db);
    const ids = (await listInFlight(db, WINDOW_END)).map((r) => r.pr.id);
    expect(ids).toContain("pr-closed-after");
  });

  it("excludes a PR that closed before the window", async () => {
    const db = createDb(":memory:");
    seed(db);
    seedInFlight(db);
    const ids = (await listInFlight(db, WINDOW_END)).map((r) => r.pr.id);
    expect(ids).not.toContain("pr-closed-before");
  });

  it("excludes a PR created after the window", async () => {
    const db = createDb(":memory:");
    seed(db);
    seedInFlight(db);
    const ids = (await listInFlight(db, WINDOW_END)).map((r) => r.pr.id);
    expect(ids).not.toContain("pr-created-after");
  });

  it("is boundary-exclusive on createdAt and inclusive on closedAt", async () => {
    const db = createDb(":memory:");
    seed(db);
    seedInFlight(db);
    // A PR created exactly at `until` hadn't opened when the window shut.
    db.insert(pullRequests)
      .values({
        repositoryId: REPO_ID,
        id: "pr-created-at-edge",
        externalId: 14,
        title: "t",
        authorLogin: "alice",
        status: "open",
        sourceBranch: "f",
        targetBranch: "main",
        url: "https://example.com",
        createdAt: WINDOW_END,
        updatedAt: WINDOW_END,
        fetchedAt: WINDOW_END,
        closedAt: null,
      })
      .run();
    // A PR closed exactly at `until` was still open for the whole window.
    db.insert(pullRequests)
      .values({
        repositoryId: REPO_ID,
        id: "pr-closed-at-edge",
        externalId: 15,
        title: "t",
        authorLogin: "alice",
        status: "merged",
        sourceBranch: "f",
        targetBranch: "main",
        url: "https://example.com",
        createdAt: "2026-06-20T00:00:00Z",
        updatedAt: WINDOW_END,
        fetchedAt: WINDOW_END,
        closedAt: WINDOW_END,
      })
      .run();

    const ids = (await listInFlight(db, WINDOW_END)).map((r) => r.pr.id);
    expect(ids).not.toContain("pr-created-at-edge");
    expect(ids).toContain("pr-closed-at-edge");
  });

  it("equals 'currently open' for a live window", async () => {
    const db = createDb(":memory:");
    seed(db);
    seedInFlight(db);
    const ids = (await listInFlight(db, new Date().toISOString())).map((r) => r.pr.id).sort();
    const openNow = db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(eq(pullRequests.status, "open"))
      .all()
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(openNow);
  });
});

describe("upsertPrs stack membership", () => {
  const storedStack = (db: Db) => {
    const row = readRow(db, "pr-open-alice");
    return { number: row.stackNumber, position: row.stackPosition };
  };
  const seedStacked = (db: Db) =>
    db
      .update(pullRequests)
      .set({ stackNumber: 7, stackPosition: 3 })
      .where(eq(pullRequests.id, "pr-open-alice"))
      .run();

  it("records a stack on first insert", async () => {
    const db = createDb(":memory:");
    seed(db);
    await runSvc(db, (svc) =>
      svc.upsertPrs([
        listSourcedPr({
          id: "pr-stacked",
          externalId: 98,
          stack: stackSeen({ number: 7, position: 2 }),
        }),
      ]),
    );
    const row = readRow(db, "pr-stacked");
    expect(row.stackNumber).toBe(7);
    expect(row.stackPosition).toBe(2);
  });

  it("never erases a stored stack on conflict from a source that didn't see stacks", async () => {
    const db = createDb(":memory:");
    seed(db);
    seedStacked(db);

    await runSvc(db, (svc) => svc.upsertPrs([listSourcedPr()]));

    expect(storedStack(db)).toEqual({ number: 7, position: 3 });
    expect(readRow(db, "pr-open-alice").title).toBe("updated title");
  });

  it.each([
    ["moves", { number: 7, position: 1 }, { number: 7, position: 1 }],
    ["clears", null, { number: null, position: null }],
  ] as const)("%s a stored stack on conflict when the row saw it", async (_, stack, want) => {
    const db = createDb(":memory:");
    seed(db);
    seedStacked(db);

    await runSvc(db, (svc) => svc.upsertPrs([listSourcedPr({ stack: stackSeen(stack) })]));

    expect(storedStack(db)).toEqual(want);
  });

  describe("through the gateway", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("keeps a stored stack through a REST detail and a detail-batch refresh", async () => {
      const db = createDb(":memory:");
      seed(db);
      seedStacked(db);
      const node = {
        number: 1,
        title: "refreshed",
        body: "",
        isDraft: false,
        url: "https://github.test/pull/1",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        closedAt: null,
        headRefName: "feature",
        baseRefName: "main",
        headRefOid: "head",
        baseRefOid: "base",
        author: { __typename: "User", login: "alice" },
        reviewRequests: { nodes: [] },
        state: "OPEN",
        mergedAt: null,
        additions: 1,
        deletions: 1,
        changedFiles: 1,
      };
      const rest = {
        number: 1,
        user: { login: "alice", avatar_url: null },
        head: { ref: "feature", sha: "head" },
        base: { ref: "main", sha: "base" },
        requested_reviewers: [],
        title: "refreshed",
        body: null,
        state: "open",
        merged_at: null,
        draft: false,
        html_url: "https://github.test/pull/1",
        additions: 1,
        deletions: 1,
        changed_files: 1,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
        closed_at: null,
      };
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL) =>
          new Response(
            JSON.stringify(
              String(input).endsWith("/graphql") ? { data: { repository: { p0: node } } } : rest,
            ),
          ),
        { preconnect: realFetch.preconnect },
      );
      const dbLayer = Layer.succeed(DbService, { db });
      const layer = Layer.mergeAll(GitHubGatewayLive, PullRequestServiceLive).pipe(
        Layer.provideMerge(
          Layer.mergeAll(GitHubEtagCacheLive, SettingsServiceLive).pipe(
            Layer.provideMerge(dbLayer),
          ),
        ),
      );
      const apiBase = "https://api.github.test";

      await Effect.runPromise(
        Effect.gen(function* () {
          const github = yield* GitHubGateway;
          const svc = yield* PullRequestService;
          const detail = yield* github.prs.get("acme/web", 1, "t", apiBase);
          yield* svc.upsertPrs([{ ...detail, id: "pr-open-alice", repositoryId: REPO_ID }]);
          expect(storedStack(db)).toEqual({ number: 7, position: 3 });

          const batch = yield* github.prs.getMany("acme/web", REPO_ID, [1], "t", apiBase);
          yield* svc.upsertPrs([...batch.values()].map((pr) => ({ ...pr, id: "pr-open-alice" })));
        }).pipe(Effect.orDie, Effect.provide(layer)),
      );

      expect(storedStack(db)).toEqual({ number: 7, position: 3 });
      expect(readRow(db, "pr-open-alice").title).toBe("refreshed");
    });
  });

  it("takes each row's stack on its own in a mixed batch", async () => {
    const db = createDb(":memory:");
    seed(db);
    seedStacked(db);

    await runSvc(db, (svc) =>
      svc.upsertPrs([
        listSourcedPr(),
        listSourcedPr({
          id: "pr-new",
          externalId: 97,
          stack: stackSeen({ number: 2, position: 1 }),
        }),
      ]),
    );

    expect(storedStack(db)).toEqual({ number: 7, position: 3 });
    expect(readRow(db, "pr-new").stackNumber).toBe(2);
  });
});

describe("setPrDraft", () => {
  it("flips only the targeted row's draft flag", async () => {
    const db = createDb(":memory:");
    seed(db);

    await runSvc(db, (svc) => svc.setPrDraft("pr-open-alice", true));
    expect(readRow(db, "pr-open-alice").isDraft).toBe(true);
    expect(readRow(db, "pr-open-alice").status).toBe("open");
    expect(readRow(db, "pr-merged-bob").isDraft).toBe(false);

    await runSvc(db, (svc) => svc.setPrDraft("pr-open-alice", false));
    expect(readRow(db, "pr-open-alice").isDraft).toBe(false);
  });
});
