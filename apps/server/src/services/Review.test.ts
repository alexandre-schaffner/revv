import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db";
import {
  account,
  commentThreads,
  pullRequests,
  repositories,
  reviewSessions,
  user,
} from "../db/schema";
import { DbService } from "./Db";
import { ReviewService, ReviewServiceLive } from "./Review";

const PR_ID = "repo-1:7";

// ── adoptExternalThreads ─────────────────────────────────────────────────────
//
// Repair path for PRs whose GitHub comments were pulled into the wrong mode's
// session before `pullComments` resolved the mode. Those comments can't be
// re-pulled — they are deduped globally by external id — so they have to be
// moved.

function seedDb(): Db {
  const db = createDb(":memory:");
  const now = new Date().toISOString();
  const nowDate = new Date();
  db.insert(user)
    .values({
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      githubLogin: "alex",
      createdAt: nowDate,
      updatedAt: nowDate,
    })
    .run();
  db.insert(account)
    .values({
      id: "account-1",
      accountId: "1",
      providerId: "github:github.com",
      userId: "user-1",
      createdAt: nowDate,
      updatedAt: nowDate,
    })
    .run();
  db.insert(repositories)
    .values({
      id: "repo-1",
      owner: "acme",
      name: "widgets",
      fullName: "acme/widgets",
      addedAt: now,
      accountId: "account-1",
    })
    .run();
  db.insert(pullRequests)
    .values({
      id: PR_ID,
      externalId: 7,
      repositoryId: "repo-1",
      title: "Add widgets",
      authorLogin: "alex",
      sourceBranch: "feat/widgets",
      targetBranch: "main",
      url: "https://github.com/acme/widgets/pull/7",
      createdAt: now,
      updatedAt: now,
      fetchedAt: now,
    })
    .run();

  for (const [id, mode] of [
    ["session-reviewer", "reviewer"],
    ["session-author", "author"],
  ] as const) {
    db.insert(reviewSessions)
      .values({ id, pullRequestId: PR_ID, mode, startedAt: now, status: "active" })
      .run();
  }

  db.insert(commentThreads)
    .values([
      {
        id: "thread-github",
        reviewSessionId: "session-reviewer",
        filePath: "src/a.ts",
        startLine: 1,
        endLine: 1,
        createdAt: now,
        externalCommentId: "96217507",
      },
      {
        id: "thread-draft",
        reviewSessionId: "session-reviewer",
        filePath: "src/b.ts",
        startLine: 2,
        endLine: 2,
        createdAt: now,
      },
      {
        id: "thread-own",
        reviewSessionId: "session-author",
        filePath: "src/c.ts",
        startLine: 3,
        endLine: 3,
        createdAt: now,
      },
    ])
    .run();
  return db;
}

const adopt = (db: Db, sessionId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reviewService = yield* ReviewService;
      return yield* reviewService.adoptExternalThreads(PR_ID, sessionId);
    }).pipe(
      Effect.provide(ReviewServiceLive),
      Effect.provide(Layer.succeed(DbService, { db })),
      Effect.orDie,
    ),
  );

describe("adoptExternalThreads", () => {
  it("moves GitHub-sourced threads into the target session and leaves drafts alone", async () => {
    const db = seedDb();

    expect(await adopt(db, "session-author")).toBe(1);

    const byId = new Map(
      db
        .select()
        .from(commentThreads)
        .all()
        .map((r) => [r.id, r.reviewSessionId]),
    );
    expect(byId.get("thread-github")).toBe("session-author");
    expect(byId.get("thread-draft")).toBe("session-reviewer");
    expect(byId.get("thread-own")).toBe("session-author");
  });

  it("is a no-op once every external thread already lives in the target session", async () => {
    const db = seedDb();

    expect(await adopt(db, "session-author")).toBe(1);
    expect(await adopt(db, "session-author")).toBe(0);
  });
});
