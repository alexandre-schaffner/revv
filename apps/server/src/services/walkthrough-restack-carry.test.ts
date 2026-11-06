import { describe, expect, it } from "bun:test";
import {
  DEFAULT_USER_SETTINGS,
  RATING_AXES,
  type WalkthroughStackSnapshot,
  type WalkthroughStreamEvent,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ZERO_TOKEN_USAGE } from "../ai/providers/walkthrough-token-usage";
import { createDb, type Db } from "../db/index";
import {
  walkthroughBlocks,
  walkthroughIssues,
  walkthroughRatings,
  walkthroughSemanticSteps,
  walkthroughs,
} from "../db/schema";
import { CacheService } from "./Cache";
import { DbService } from "./Db";
import { JevService } from "./Jev";
import { fingerprintFiles } from "./stacks/fingerprint";
import { WalkthroughService, WalkthroughServiceLive } from "./Walkthrough";
import {
  WalkthroughSnapshotImporter,
  WalkthroughSnapshotImporterLive,
} from "./WalkthroughSnapshotImporter";
import { planRestackCarry, planWalkthroughLaunch } from "./walkthrough/launch-plan";
import { makeWalkthroughLifecycle } from "./walkthrough/lifecycle";
import { exportWalkthroughSnapshot } from "./walkthrough-snapshot";

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

function seedSource(db: Db): void {
  (db as unknown as Client).session.client.run("PRAGMA foreign_keys = OFF");
  insertRow(db, {
    id: "wt-old",
    status: "superseded",
    lastCompletedPhase: "D",
    completedAt: NOW,
    summary: "Adds a limiter.",
    sentiment: "Ship it.",
    diffFingerprint: fingerprintFiles(FILES),
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

describe("restack carry", () => {
  it("carries the review into the new head's row, minus what was posted to GitHub", async () => {
    const db = createDb(":memory:");
    seedSource(db);
    const events: WalkthroughStreamEvent[] = [];

    const walkthroughId = await run(
      db,
      Effect.gen(function* () {
        const service = yield* WalkthroughService;
        const importer = yield* WalkthroughSnapshotImporter;
        const id = yield* service.createPartial({
          reviewSessionId: "session-1",
          prId: "pr-1",
          modelUsed: "current-model",
          prHeadSha: "head-2",
          stackContext: STACK,
          diffFingerprint: fingerprintFiles(FILES),
        });
        const snapshot = exportWalkthroughSnapshot(db, {
          walkthroughId: "wt-old",
          repoFullName: "o/r",
        });
        yield* importer.import({ walkthroughId: id, snapshot });
        yield* service.markCarriedFrom(id, "wt-old");
        const lifecycle = makeWalkthroughLifecycle({
          db,
          walkthroughs: service,
          remoteCache: { push: () => Effect.die("an import is never pushed") } as never,
          emit: (_id, event) => Effect.sync(() => events.push(event)),
        });
        yield* lifecycle.complete(id, ZERO_TOKEN_USAGE, "restack");
        return id;
      }),
    );

    const row = db.select().from(walkthroughs).where(eq(walkthroughs.id, walkthroughId)).get();
    expect(row?.status).toBe("complete");
    expect(row?.lastCompletedPhase).toBe("D");
    expect(row?.prHeadSha).toBe("head-2");
    expect(row?.carriedFromWalkthroughId).toBe("wt-old");
    expect(row?.summary).toBe("Adds a limiter.");
    expect(row?.stackContext).toEqual(STACK);
    expect(row?.diffFingerprint).toEqual(fingerprintFiles(FILES));

    const issues = db
      .select({ title: walkthroughIssues.title })
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
      .all();
    expect(issues.map((i) => i.title)).toEqual(["i-open"]);

    expect(events.map((e) => e.type)).toEqual(["lifecycle:cache-hit", "lifecycle:complete"]);
    expect(events[0]).toEqual({
      type: "lifecycle:cache-hit",
      data: { walkthroughId, source: "restack" },
    });
  });
});

describe("planRestackCarry", () => {
  const fingerprint = fingerprintFiles(FILES);
  const source = (generationMode: "full" | "incremental") => ({
    id: "wt-old",
    generationMode,
    diffFingerprint: fingerprint,
  });

  it("carries a full review into an incremental request, as a full review", () => {
    expect(planRestackCarry(source("full"), "incremental", fingerprint)).toEqual({
      fromWalkthroughId: "wt-old",
      generationMode: "full",
    });
  });

  it("never lets an incremental review stand in for a full one", () => {
    expect(planRestackCarry(source("incremental"), "full", fingerprint)).toBeNull();
    expect(planRestackCarry(source("incremental"), "incremental", fingerprint)).toEqual({
      fromWalkthroughId: "wt-old",
      generationMode: "incremental",
    });
  });

  it("stands aside when the layer's own changes moved", () => {
    const moved = fingerprintFiles([
      { filename: "src/a.ts", status: "modified", patch: "@@ -2 +2 @@\n+a" },
    ]);
    expect(planRestackCarry(source("full"), "full", moved)).toBeNull();
  });
});

describe("planWalkthroughLaunch: stack inputs", () => {
  const plan = (
    db: Db,
    overrides: {
      existing?: { id: string; parentWalkthroughId?: string; baseHeadSha?: string };
      trigger?: "user" | "resume";
    },
  ) =>
    run(
      db,
      planWalkthroughLaunch({
        db,
        resolved: {
          pr: { id: "pr-1" },
          repo: { id: "repo-1" },
          files: FILES.map((f) => ({ ...f, previousFilename: null, additions: 1, deletions: 0 })),
          commits: [],
          meta: { headSha: "head-2" },
        } as never,
        mode: "reviewer",
        requestedGenerationMode: "incremental",
        existing: overrides.existing ?? null,
        trigger: overrides.trigger ?? "user",
        settings: DEFAULT_USER_SETTINGS,
        agent: "claude-code",
        snapshotStack: Effect.succeed(STACK),
        cacheProbe: Effect.succeed(true),
      }).pipe(
        Effect.provideService(JevService, {} as never),
        Effect.provideService(CacheService, {} as never),
      ),
    );

  it("plans the carry an incremental request accepts from a full review", async () => {
    const db = createDb(":memory:");
    seedSource(db);
    const result = await plan(db, {});
    expect(result.stack).toEqual(STACK);
    expect(result.restack).toEqual({ fromWalkthroughId: "wt-old", generationMode: "full" });
    expect(result.generationMode).toBe("full");
    expect(result.parentFingerprint).toBeNull();
  });

  it("never carries on a resume, and reads the row's own stack", async () => {
    const db = createDb(":memory:");
    seedSource(db);
    insertRow(db, {
      id: "wt-resumed",
      prHeadSha: "head-2",
      status: "generating",
      generationMode: "incremental",
      parentWalkthroughId: "wt-old",
      baseHeadSha: "head-1",
      stackContext: STACK,
    });
    const result = await plan(db, {
      existing: { id: "wt-resumed", parentWalkthroughId: "wt-old", baseHeadSha: "head-1" },
      trigger: "resume",
    });
    expect(result.restack).toBeNull();
    expect(result.stack).toEqual(STACK);
    expect(result.parentFingerprint).toEqual(fingerprintFiles(FILES));
  });

  it("reuses the plan recorded on the row, so every run launches the same way", async () => {
    const db = createDb(":memory:");
    seedSource(db);
    const recorded = {
      agent: "codex" as const,
      model: "recorded-model",
      thinkingEffort: null,
      sizing: null,
      filePriorities: [{ filename: "src/a.ts", tier: 1 }],
      splitRecommendation: null,
      adjudicateContinuations: false,
    };
    insertRow(db, {
      id: "wt-planned",
      prHeadSha: "head-2",
      status: "generating",
      launchPlan: recorded,
    });
    const result = await plan(db, { existing: { id: "wt-planned" }, trigger: "resume" });
    expect(result.plan).toEqual(recorded);
    expect(result.planIsNew).toBe(false);
    expect(result.providerConfig.model).toBe("recorded-model");
  });
});
