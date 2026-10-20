import { describe, expect, it } from "bun:test";
import {
  RATING_AXES,
  type WalkthroughStackSnapshot,
  type WalkthroughStreamEvent,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import {
  walkthroughBlocks,
  walkthroughIssues,
  walkthroughRatings,
  walkthroughSemanticSteps,
  walkthroughs,
} from "../db/schema";
import { ImportError } from "../domain/errors";
import { DbService } from "./Db";
import { fingerprintFiles } from "./stacks/fingerprint";
import { WalkthroughService, WalkthroughServiceLive } from "./Walkthrough";
import {
  WalkthroughSnapshotImporter,
  WalkthroughSnapshotImporterLive,
} from "./WalkthroughSnapshotImporter";
import { tryCarryRestackedWalkthrough } from "./walkthrough-cache-import";

const NOW = "2026-10-16T00:00:00Z";
const FILES = [{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n+a" }];
const STACK: WalkthroughStackSnapshot = {
  number: 7,
  baseRefName: "main",
  position: 2,
  layers: [],
  capturedAt: NOW,
};

type Client = { session: { client: { run: (sql: string) => void } } };

function insertRow(db: Db, row: Partial<typeof walkthroughs.$inferInsert> & { id: string }) {
  db.insert(walkthroughs)
    .values({
      reviewSessionId: "session-1",
      pullRequestId: "pr-1",
      generatedAt: NOW,
      modelUsed: "test-model",
      tokenUsage: "{}",
      prHeadSha: "head-1",
      ...row,
    })
    .run();
}

/** A finished review at head-1, retired by the push that restacked the layer. */
function seedSource(db: Db): void {
  (db as unknown as Client).session.client.run("PRAGMA foreign_keys = OFF");
  insertRow(db, {
    id: "wt-old",
    status: "superseded",
    lastCompletedPhase: "D",
    completedAt: NOW,
    summary: "Adds a limiter.",
    sentiment: "Ship it.",
    diffFingerprint: JSON.stringify(fingerprintFiles(FILES)),
  });
  db.insert(walkthroughSemanticSteps)
    .values({
      id: "ss-0",
      walkthroughId: "wt-old",
      semanticStepIndex: 0,
      title: "Limiter",
      createdAt: NOW,
    })
    .run();
  db.insert(walkthroughBlocks)
    .values({
      id: "b-0",
      walkthroughId: "wt-old",
      semanticStepIndex: 0,
      order: 0,
      stepIndex: 0,
      type: "markdown",
      data: JSON.stringify({ type: "markdown", content: "The limiter." }),
      createdAt: NOW,
    })
    .run();
  for (const [id, submittedAt] of [
    ["i-open", null],
    ["i-posted", NOW],
  ] as const) {
    db.insert(walkthroughIssues)
      .values({
        id,
        walkthroughId: "wt-old",
        order: id === "i-open" ? 0 : 1,
        severity: "warning",
        title: id,
        description: "d",
        submittedAt,
        createdAt: NOW,
      })
      .run();
  }
  for (const axis of RATING_AXES) {
    db.insert(walkthroughRatings)
      .values({
        id: `r-${axis}`,
        walkthroughId: "wt-old",
        axis,
        verdict: "pass",
        confidence: "high",
        rationale: "Fine.",
        details: "Fine.",
        citations: "[]",
        blockIds: "[]",
        createdAt: NOW,
      })
      .run();
  }
}

function run<A, E>(
  db: Db,
  eff: Effect.Effect<A, E, WalkthroughService | WalkthroughSnapshotImporter | DbService>,
) {
  return Effect.runPromise(
    eff.pipe(
      Effect.provide(Layer.mergeAll(WalkthroughServiceLive, WalkthroughSnapshotImporterLive)),
      Effect.provide(Layer.succeed(DbService, { db })),
    ),
  );
}

describe("findRestackSource", () => {
  it("finds a superseded review that finished all four phases at another head", async () => {
    const db = createDb(":memory:");
    seedSource(db);
    const source = await run(
      db,
      Effect.flatMap(WalkthroughService, (s) => s.findRestackSource("pr-1", "head-2", "reviewer")),
    );
    expect(source?.id).toBe("wt-old");
    expect(source?.diffFingerprint).toEqual(fingerprintFiles(FILES));
  });

  it("stands aside once the new head has a live row, so Regenerate reaches the agent", async () => {
    const db = createDb(":memory:");
    seedSource(db);
    insertRow(db, { id: "wt-new", prHeadSha: "head-2", status: "complete" });
    const source = await run(
      db,
      Effect.flatMap(WalkthroughService, (s) => s.findRestackSource("pr-1", "head-2", "reviewer")),
    );
    expect(source).toBeNull();
  });

  it("ignores a review without a fingerprint (before stacks were tracked)", async () => {
    const db = createDb(":memory:");
    seedSource(db);
    db.update(walkthroughs)
      .set({ diffFingerprint: null })
      .where(eq(walkthroughs.id, "wt-old"))
      .run();
    const source = await run(
      db,
      Effect.flatMap(WalkthroughService, (s) => s.findRestackSource("pr-1", "head-2", "reviewer")),
    );
    expect(source).toBeNull();
  });
});

describe("tryCarryRestackedWalkthrough", () => {
  it("carries the review into the new head's row, minus what was posted to GitHub", async () => {
    const db = createDb(":memory:");
    seedSource(db);
    const events: WalkthroughStreamEvent[] = [];

    const carried = await run(
      db,
      Effect.gen(function* () {
        const service = yield* WalkthroughService;
        const importer = yield* WalkthroughSnapshotImporter;
        const walkthroughId = yield* service.createPartial({
          reviewSessionId: "session-1",
          prId: "pr-1",
          modelUsed: "current-model",
          prHeadSha: "head-2",
          stackContext: STACK,
          diffFingerprint: fingerprintFiles(FILES),
        });
        const provide = <A, E>(eff: Effect.Effect<A, E, DbService>) =>
          Effect.provideService(eff, DbService, { db });
        const ok = yield* tryCarryRestackedWalkthrough({
          db,
          fromWalkthroughId: "wt-old",
          walkthroughId,
          prId: "pr-1",
          repoFullName: "o/r",
          headSha: "head-2",
          importSnapshot: (snapshot) =>
            provide(
              importer
                .import({ walkthroughId, snapshot })
                .pipe(
                  Effect.zipRight(
                    service
                      .markCarriedFrom(walkthroughId, "wt-old")
                      .pipe(
                        Effect.mapError(
                          (e) => new ImportError({ walkthroughId, reason: e.message }),
                        ),
                      ),
                  ),
                ),
            ),
          markComplete: provide(service.setStatus(walkthroughId, "complete")),
          emitEvent: (event) => Effect.sync(() => events.push(event)),
        });
        return { ok, walkthroughId };
      }),
    );

    expect(carried.ok).toBe(true);
    const row = db
      .select()
      .from(walkthroughs)
      .where(eq(walkthroughs.id, carried.walkthroughId))
      .get();
    expect(row?.status).toBe("complete");
    expect(row?.lastCompletedPhase).toBe("D");
    expect(row?.prHeadSha).toBe("head-2");
    expect(row?.carriedFromWalkthroughId).toBe("wt-old");
    expect(row?.summary).toBe("Adds a limiter.");
    expect(JSON.parse(row?.stackContext ?? "null")).toEqual(STACK);
    expect(JSON.parse(row?.diffFingerprint ?? "null")).toEqual(fingerprintFiles(FILES));

    const issues = db
      .select({ title: walkthroughIssues.title })
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.walkthroughId, carried.walkthroughId))
      .all();
    expect(issues.map((i) => i.title)).toEqual(["i-open"]);

    expect(events.map((e) => e.type)).toEqual(["lifecycle:cache-hit", "lifecycle:complete"]);
    expect(events[0]).toEqual({
      type: "lifecycle:cache-hit",
      data: { walkthroughId: carried.walkthroughId, source: "restack" },
    });
  });
});
