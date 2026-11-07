import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Cause, type Context, Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { reviewRounds, walkthroughs } from "../db/schema";
import { DbService } from "./Db";
import { WalkthroughService, WalkthroughServiceLive } from "./Walkthrough";

/** Rows for PR `pr-1`, with foreign keys off so the PR / session rows needn't exist. */
function insertWalkthroughs(
  db: Db,
  ...rows: readonly (Partial<typeof walkthroughs.$inferInsert> & { id: string })[]
): void {
  db.$client.run("PRAGMA foreign_keys = OFF");
  for (const row of rows) {
    db.insert(walkthroughs)
      .values({
        reviewSessionId: "session-1",
        pullRequestId: "pr-1",
        generatedAt: "2026-01-01T00:00:00Z",
        modelUsed: "test-model",
        prHeadSha: "head-1",
        ...row,
      })
      .run();
  }
}

const runWalkthrough = <A, E>(
  db: Db,
  f: (service: Context.Service.Shape<typeof WalkthroughService>) => Effect.Effect<A, E, DbService>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* WalkthroughService);
    }).pipe(
      Effect.provide(WalkthroughServiceLive),
      Effect.provide(Layer.succeed(DbService, { db })),
    ),
  );

function seedWalkthroughRound(db: Db): void {
  insertWalkthroughs(db, { id: "wt-1" });
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

describe("finish", () => {
  it("updates walkthrough and review round status together with one completion timestamp", async () => {
    const db = createDb(":memory:");
    seedWalkthroughRound(db);

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WalkthroughService;
        yield* service.finish("wt-1", "complete");
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

  // A throw from raw Drizzle must reach the orchestrator as a failure it can
  // handle, not die as a defect.
  it("fails with DbError when the write doesn't commit", async () => {
    const db = createDb(":memory:");
    seedWalkthroughRound(db);
    db.$client.close();

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(WalkthroughService, (service) => service.finish("wt-1", "complete")).pipe(
        Effect.provide(WalkthroughServiceLive),
        Effect.provide(Layer.succeed(DbService, { db })),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(true);
      expect(Cause.hasDies(exit.cause)).toBe(false);
    }
  });
});

describe("walkthrough risk hydration", () => {
  it("returns an orchestrator-assigned risk before Phase A has written a summary", async () => {
    const db = createDb(":memory:");
    insertWalkthroughs(db, {
      id: "wt-risk",
      summary: "",
      riskLevel: "high",
      riskConfidence: 0.99,
      status: "generating",
      lastCompletedPhase: "none",
    });

    const partial = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* WalkthroughService).getPartial("pr-1", "head-1");
      }).pipe(
        Effect.provide(WalkthroughServiceLive),
        Effect.provide(Layer.succeed(DbService, { db })),
      ),
    );

    expect(partial?.summary).toBe("");
    expect(partial?.riskLevel).toBe("high");
    expect(partial?.riskConfidence).toBe(0.99);
  });
});

describe("resume incremental walkthrough", () => {
  function seedIncrementalGenerating(db: Db): void {
    insertWalkthroughs(db, {
      id: "wt-inc",
      prHeadSha: "head-2",
      status: "generating",
      mode: "author",
      generationMode: "incremental",
      parentWalkthroughId: "wt-parent",
      baseHeadSha: "head-1",
    });
  }

  function seedFullGeneratingAtSameSha(db: Db): void {
    insertWalkthroughs(db, {
      id: "wt-full",
      reviewSessionId: "session-2",
      generatedAt: "2026-01-01T00:01:00Z",
      prHeadSha: "head-2",
      status: "generating",
      mode: "author",
      generationMode: "full",
    });
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
});

describe("a new row at a head", () => {
  // What Stop leaves behind: an `error` row the user cancelled, at the current head.
  function seedStoppedRun(db: Db): void {
    insertWalkthroughs(db, {
      id: "wt-stopped",
      status: "error",
      endReason: "cancelled",
      lastCompletedPhase: "B",
      mode: "author",
      generationMode: "full",
    });
  }

  it("retires the row it replaces at that head and points it at the new one", async () => {
    const db = createDb(":memory:");
    seedStoppedRun(db);

    const newId = await runWalkthrough(db, (service) =>
      service.createRow({
        reviewSessionId: "session-1",
        prId: "pr-1",
        prHeadSha: "head-1",
        mode: "author",
        generationMode: "full",
        parentWalkthroughId: null,
        baseHeadSha: null,
      }),
    );

    expect(newId).not.toBe("wt-stopped");
    const rows = db
      .select({
        id: walkthroughs.id,
        status: walkthroughs.status,
        supersededBy: walkthroughs.supersededBy,
      })
      .from(walkthroughs)
      .all();
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: "wt-stopped", status: "superseded", supersededBy: newId },
        { id: newId, status: "generating", supersededBy: null },
      ]),
    );
  });
});

describe("getLatestMode", () => {
  const latestMode = (db: Db) => runWalkthrough(db, (s) => s.getLatestMode("pr-1"));

  it("is null when the PR has no walkthrough", async () => {
    expect(await latestMode(createDb(":memory:"))).toBeNull();
  });

  it("follows the newest row, whatever its perspective", async () => {
    const db = createDb(":memory:");
    insertWalkthroughs(
      db,
      { id: "a", mode: "author", status: "complete", generatedAt: "2026-01-01T00:00:00Z" },
      { id: "b", mode: "reviewer", status: "generating", generatedAt: "2026-01-02T00:00:00Z" },
    );
    expect(await latestMode(db)).toBe("reviewer");
  });

  it("counts superseded rows, so a stale walkthrough keeps its perspective", async () => {
    const db = createDb(":memory:");
    insertWalkthroughs(
      db,
      { id: "a", mode: "author", status: "complete", generatedAt: "2026-01-01T00:00:00Z" },
      { id: "b", mode: "reviewer", status: "superseded", generatedAt: "2026-01-02T00:00:00Z" },
    );
    expect(await latestMode(db)).toBe("reviewer");
  });
});

// Only one perspective is active per PR, so a switch retires the other one's
// walkthrough. Its report must stay readable from the history.
describe("history across perspectives", () => {
  function seedSwitch(db: Db): void {
    insertWalkthroughs(
      db,
      {
        id: "wt-author",
        mode: "author",
        status: "superseded",
        generatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "wt-reviewer",
        mode: "reviewer",
        status: "complete",
        generatedAt: "2026-01-02T00:00:00Z",
      },
    );
  }

  it("lists rounds from both perspectives, each labelled", async () => {
    const db = createDb(":memory:");
    seedSwitch(db);
    const { rounds } = await runWalkthrough(db, (s) => s.listReviewRounds("pr-1", "head-1"));
    expect(rounds.map((r) => [r.walkthroughId, r.mode])).toEqual([
      ["wt-author", "author"],
      ["wt-reviewer", "reviewer"],
    ]);
  });

  it("opens a report in the other perspective", async () => {
    const db = createDb(":memory:");
    seedSwitch(db);
    const report = await runWalkthrough(db, (s) => s.getReport("pr-1", "wt-author"));
    expect(report?.walkthrough.mode).toBe("author");
  });
});
