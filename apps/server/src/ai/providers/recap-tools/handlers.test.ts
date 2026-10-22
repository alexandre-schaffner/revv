import { describe, expect, it } from "bun:test";
import type { RecapSummaryStats } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { createDb, type Db } from "../../../db/index";
import { projectRecaps } from "../../../db/schema/index";
import {
  addPrEntryHandler,
  completeRecapHandler,
  recapCompletionBlocker,
  setLedeHandler,
} from "./handlers";
import type { RecapSourceBundle, RecapSourcePr, RecapToolContext } from "./spec";

const RECAP = "recap-1";

const STATS: RecapSummaryStats = {
  prCount: 2,
  mergedCount: 1,
  closedCount: 0,
  authorCount: 1,
  riskBreakdown: { low: 1, medium: 0, high: 0 },
  walkthroughsMissingCount: 1,
};

function pr(id: string, walkthroughId: string | null): RecapSourcePr {
  return {
    id,
    externalId: 1,
    title: id,
    authorLogin: "",
    status: "merged",
    closedAt: "2026-10-20T00:00:00.000Z",
    sourceBranch: "feat",
    targetBranch: "main",
    additions: 3,
    deletions: 1,
    changedFiles: 1,
    url: "",
    body: null,
    walkthrough: walkthroughId
      ? { id: walkthroughId, summary: "", sentiment: null, riskLevel: "low", completedAt: null }
      : null,
    diffDigest: null,
  };
}

const BUNDLE: RecapSourceBundle = {
  repoId: "repo-1",
  repoFullName: "acme/app",
  period: "daily",
  periodStart: "2026-10-20T00:00:00.000Z",
  periodEnd: "2026-10-21T00:00:00.000Z",
  prs: [pr("pr-shipped", "wt-1")],
  openPrs: [pr("pr-open", null)],
  stats: STATS,
};

function seed(status = "generating"): Db {
  const db = createDb(":memory:");
  (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
    "PRAGMA foreign_keys = OFF",
  );
  db.insert(projectRecaps)
    .values({
      id: RECAP,
      repositoryId: "repo-1",
      period: "daily",
      periodStart: BUNDLE.periodStart,
      periodEnd: BUNDLE.periodEnd,
      status,
      generatedAt: new Date().toISOString(),
    })
    .run();
  return db;
}

function ctxFor(db: Db, completed: { count: number } = { count: 0 }): RecapToolContext {
  return {
    db,
    recapId: RECAP,
    sourceBundle: BUNDLE,
    priorRecaps: [],
    getPrDiff: () => Effect.succeed(null),
    onCompleted: () => {
      completed.count++;
    },
    emit: () => {},
    onToolCall: () => {},
  };
}

function recap(db: Db) {
  const row = db.select().from(projectRecaps).where(eq(projectRecaps.id, RECAP)).get();
  if (!row) throw new Error("recap missing");
  return row;
}

const entry = (prId: string, position: number) => ({
  pr_id: prId,
  position,
  theme: "storage",
  verb: "shipped",
  description: "Moves the cache to disk.",
  lines_added: 3,
  lines_removed: 1,
});

describe("recapCompletionBlocker", () => {
  it("names what's missing until the journal has a lede and an entry", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    expect(recapCompletionBlocker(db, RECAP)).toContain("lede is empty");
    await setLedeHandler(ctx, { lede: "Storage moved to disk." });
    expect(recapCompletionBlocker(db, RECAP)).toContain("no PR entries");
    await addPrEntryHandler(ctx, entry("pr-shipped", 0));
    expect(recapCompletionBlocker(db, RECAP)).toBeNull();
  });

  it("refuses a recap that is no longer generating", () => {
    expect(recapCompletionBlocker(seed("error"), RECAP)).toContain("no longer generating");
  });
});

describe("add_pr_entry", () => {
  it("keeps the recap's derived fields in step with its entries", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    await addPrEntryHandler(ctx, entry("pr-shipped", 0));
    await addPrEntryHandler(ctx, entry("pr-open", 1));
    const row = recap(db);
    expect(JSON.parse(row.summaryStats)).toEqual(STATS);
    expect(JSON.parse(row.sourcePrIds).sort()).toEqual(["pr-open", "pr-shipped"]);
    expect(JSON.parse(row.sourceWalkthroughIds)).toEqual(["wt-1"]);
  });
});

describe("complete_recap", () => {
  it("signals the orchestrator without writing anything", async () => {
    const db = seed();
    const completed = { count: 0 };
    const ctx = ctxFor(db, completed);
    await setLedeHandler(ctx, { lede: "Storage moved to disk." });
    await addPrEntryHandler(ctx, entry("pr-shipped", 0));
    const before = recap(db);
    const result = await completeRecapHandler(ctx, {});
    expect(result.isError).toBeUndefined();
    expect(completed.count).toBe(1);
    expect(recap(db)).toEqual(before);
  });

  it("refuses and stays silent while the gate blocks", async () => {
    const db = seed();
    const completed = { count: 0 };
    const result = await completeRecapHandler(ctxFor(db, completed), {});
    expect(result.isError).toBe(true);
    expect(completed.count).toBe(0);
  });
});
