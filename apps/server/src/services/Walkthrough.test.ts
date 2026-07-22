import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { reviewRounds, walkthroughs } from "../db/schema";
import { DbService } from "./Db";
import type { PrCommit } from "./GitHub";
import { __walkthroughTest, WalkthroughService, WalkthroughServiceLive } from "./Walkthrough";

function commit(sha: string, message: string): PrCommit {
  return {
    sha,
    message,
    authorLogin: null,
    authorAvatarUrl: null,
    date: null,
  };
}

describe("commitsInRoundRange", () => {
  const commits = [
    commit("a", "feat: initial"),
    commit("b", "fix: reviewed base"),
    commit("c", "feat: add indexes"),
    commit("d", "test: coverage"),
    commit("e", "fix: tune range query"),
  ];

  it("returns commits after fromSha through toSha for a normal forward range", () => {
    expect(__walkthroughTest.commitsInRoundRange(commits, "b", "d").map((c) => c.sha)).toEqual([
      "c",
      "d",
    ]);
  });

  it("returns an empty range when fromSha equals toSha", () => {
    expect(__walkthroughTest.commitsInRoundRange(commits, "c", "c")).toEqual([]);
  });

  it("returns commits after fromSha when toSha is missing from the snapshot", () => {
    expect(
      __walkthroughTest.commitsInRoundRange(commits, "b", "missing").map((c) => c.sha),
    ).toEqual(["c", "d", "e"]);
  });

  it("returns all commits when neither boundary is available", () => {
    expect(
      __walkthroughTest
        .commitsInRoundRange(commits, "missing-base", "missing-head")
        .map((c) => c.sha),
    ).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("deriveRoundFocusTitle", () => {
  it("returns null when persisted commits are unavailable", () => {
    expect(__walkthroughTest.deriveRoundFocusTitle(null, "b", "d")).toBeNull();
  });

  it("uses the newest non-low-signal commit in the selected round", () => {
    const commits = [
      commit("a", "feat: base"),
      commit("b", "fix: previous review"),
      commit("c", "feat(db): add range indexes"),
      commit("d", "test: add query coverage"),
    ];

    expect(__walkthroughTest.deriveRoundFocusTitle(JSON.stringify(commits), "b", "d")).toBe(
      "add range indexes",
    );
  });
});

function seedWalkthroughRound(db: Db): void {
  const sqlite = (db as unknown as { session: { client: { run: (sql: string) => void } } }).session
    .client;
  sqlite.run("PRAGMA foreign_keys = OFF");
  db.insert(walkthroughs)
    .values({
      id: "wt-1",
      reviewSessionId: "session-1",
      pullRequestId: "pr-1",
      generatedAt: "2026-01-01T00:00:00Z",
      modelUsed: "test-model",
      prHeadSha: "head-1",
    })
    .run();
  db.insert(reviewRounds)
    .values({
      id: "round-1",
      pullRequestId: "pr-1",
      reviewSessionId: "session-1",
      walkthroughId: "wt-1",
      roundNumber: 1,
      toSha: "head-1",
      createdAt: "2026-01-01T00:00:00Z",
    })
    .run();
}

describe("setStatus", () => {
  it("updates walkthrough and review round status together with one completion timestamp", async () => {
    const db = createDb(":memory:");
    seedWalkthroughRound(db);

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WalkthroughService;
        yield* service.setStatus("wt-1", "complete");
      }).pipe(
        Effect.provide(WalkthroughServiceLive),
        Effect.provide(Layer.succeed(DbService, { db })),
      ),
    );

    const walkthrough = db
      .select({ status: walkthroughs.status, completedAt: walkthroughs.completedAt })
      .from(walkthroughs)
      .where(eq(walkthroughs.id, "wt-1"))
      .get();
    const round = db
      .select({ status: reviewRounds.status, completedAt: reviewRounds.completedAt })
      .from(reviewRounds)
      .where(eq(reviewRounds.id, "round-1"))
      .get();

    expect(walkthrough?.status).toBe("complete");
    expect(round?.status).toBe("complete");
    expect(walkthrough?.completedAt).toBeTruthy();
    expect(round?.completedAt).toBe(walkthrough?.completedAt);
  });
});

// Regression: resuming an incremental walkthrough used to crash with
// `UNIQUE constraint failed: walkthroughs.id`. `resumePending` didn't pass the
// row's generationMode, so the resume defaulted to "full", `createPartial`'s
// dedup keyed on the wrong (prId, headSha, mode, generationMode) tuple, missed
// the existing incremental row, and tried to INSERT a duplicate id.
describe("resume incremental walkthrough", () => {
  function seedIncrementalGenerating(db: Db): void {
    const sqlite = (db as unknown as { session: { client: { run: (sql: string) => void } } })
      .session.client;
    sqlite.run("PRAGMA foreign_keys = OFF");
    db.insert(walkthroughs)
      .values({
        id: "wt-inc",
        reviewSessionId: "session-1",
        pullRequestId: "pr-1",
        generatedAt: "2026-01-01T00:00:00Z",
        modelUsed: "test-model",
        prHeadSha: "head-2",
        status: "generating",
        mode: "author",
        generationMode: "incremental",
        parentWalkthroughId: "wt-parent",
        baseHeadSha: "head-1",
      })
      .run();
  }

  function seedFullGeneratingAtSameSha(db: Db): void {
    db.insert(walkthroughs)
      .values({
        id: "wt-full",
        reviewSessionId: "session-2",
        pullRequestId: "pr-1",
        generatedAt: "2026-01-01T00:01:00Z",
        modelUsed: "test-model",
        prHeadSha: "head-2",
        status: "generating",
        mode: "author",
        generationMode: "full",
      })
      .run();
  }

  it("listGenerating surfaces generationMode so resume can preserve it", async () => {
    const db = createDb(":memory:");
    seedIncrementalGenerating(db);

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* WalkthroughService).listGenerating();
      }).pipe(
        Effect.provide(WalkthroughServiceLive),
        Effect.provide(Layer.succeed(DbService, { db })),
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("wt-inc");
    expect(rows[0]?.generationMode).toBe("incremental");
  });

  it("findResumable surfaces generationMode for manual resume", async () => {
    const db = createDb(":memory:");
    seedIncrementalGenerating(db);

    const row = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* WalkthroughService).findResumable("pr-1", "author");
      }).pipe(
        Effect.provide(WalkthroughServiceLive),
        Effect.provide(Layer.succeed(DbService, { db })),
      ),
    );

    expect(row?.id).toBe("wt-inc");
    expect(row?.generationMode).toBe("incremental");
  });

  it("getPartial can disambiguate rows by generationMode", async () => {
    const db = createDb(":memory:");
    seedIncrementalGenerating(db);
    seedFullGeneratingAtSameSha(db);

    const partial = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* WalkthroughService).getPartial(
          "pr-1",
          "head-2",
          "author",
          "incremental",
        );
      }).pipe(
        Effect.provide(WalkthroughServiceLive),
        Effect.provide(Layer.succeed(DbService, { db })),
      ),
    );

    expect(partial?.id).toBe("wt-inc");
    expect(partial?.generationMode).toBe("incremental");
  });

  it("createPartial reuses the existing row on a same-mode resume (no duplicate-id insert)", async () => {
    const db = createDb(":memory:");
    seedIncrementalGenerating(db);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* WalkthroughService).createPartial({
          id: "wt-inc",
          reviewSessionId: "session-1",
          prId: "pr-1",
          modelUsed: "test-model",
          prHeadSha: "head-2",
          mode: "author",
          generationMode: "incremental",
          parentWalkthroughId: "wt-parent",
          baseHeadSha: "head-1",
        });
      }).pipe(
        Effect.provide(WalkthroughServiceLive),
        Effect.provide(Layer.succeed(DbService, { db })),
      ),
    );

    expect(result).toBe("wt-inc");
    const count = db.select({ id: walkthroughs.id }).from(walkthroughs).all().length;
    expect(count).toBe(1);
  });
});
