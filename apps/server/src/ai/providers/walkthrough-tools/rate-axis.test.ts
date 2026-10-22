import { describe, expect, it } from "bun:test";
import type { WalkthroughStreamEvent } from "@revv/shared";
import { RATING_AXES } from "@revv/shared";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../../db/index";
import { walkthroughRatings, walkthroughs } from "../../../db/schema";
import { rateAxisHandler } from "./index";
import type { RateAxisInput, WalkthroughToolContext } from "./spec";

const WT = "wt-1";
const CITATION = { file_path: "a.ts", start_line: 1, end_line: 2, note: null };

function seed(opts: { emptyRows?: boolean } = {}): Db {
  const db = createDb(":memory:");
  // Only the two tables under test are seeded; the walkthrough's PR and
  // review-session parents are irrelevant to rate_axis.
  (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
    "PRAGMA foreign_keys = OFF",
  );
  const now = new Date().toISOString();
  db.insert(walkthroughs)
    .values({
      id: WT,
      reviewSessionId: "session-1",
      pullRequestId: "repo-1:1",
      summary: "a summary",
      sentiment: "a sentiment",
      status: "generating",
      lastCompletedPhase: "C",
      generatedAt: now,
      modelUsed: "test",
      tokenUsage: "{}",
      prHeadSha: "deadbeef",
    })
    .run();
  // Rows the retired Jev verdict pass seeded: a verdict, no prose.
  if (opts.emptyRows) {
    for (const axis of RATING_AXES) {
      db.insert(walkthroughRatings)
        .values({
          id: `r-${axis}`,
          walkthroughId: WT,
          axis,
          verdict: "concern",
          confidence: "high",
          rationale: "",
          details: "",
          citations: "[]",
          blockIds: "[]",
          createdAt: now,
        })
        .run();
    }
  }
  return db;
}

function ctxFor(db: Db, events: WalkthroughStreamEvent[] = []): WalkthroughToolContext {
  return {
    db,
    walkthroughId: WT,
    emit: (e) => {
      events.push(e);
    },
    broadcastThreadEvent: () => {},
    jev: {
      scheduleIssueJudgment: () => {},
      awaitIssueJudgments: () => Promise.resolve(),
      issueRetracted: () => false,
      judgeArtifact: () => Promise.resolve({ failed: [], reject: false }),
      scheduleProseCheck: () => {},
      takeProseAdvice: () => null,
    },
  };
}

function rating(over: Partial<RateAxisInput> = {}): RateAxisInput {
  return {
    axis: "correctness",
    verdict: "pass",
    confidence: "high",
    rationale: "Read the changed paths and their callers.",
    details: "",
    citations: [],
    block_refs: [],
    ...over,
  };
}

function phaseOf(db: Db): string | undefined {
  return db
    .select({ p: walkthroughs.lastCompletedPhase })
    .from(walkthroughs)
    .where(eq(walkthroughs.id, WT))
    .get()?.p;
}

describe("rate_axis", () => {
  it("writes the agent's verdict", async () => {
    const db = seed();
    const res = await rateAxisHandler(ctxFor(db), rating({ axis: "tests", verdict: "pass" }));
    expect(res.isError).toBeFalsy();
    const row = db
      .select()
      .from(walkthroughRatings)
      .where(eq(walkthroughRatings.axis, "tests"))
      .get();
    expect(row?.verdict).toBe("pass");
  });

  it("rejects an uncited non-pass verdict and writes nothing", async () => {
    const db = seed();
    const res = await rateAxisHandler(
      ctxFor(db),
      rating({ axis: "safety", verdict: "concern", citations: [] }),
    );
    expect(res.isError).toBe(true);
    expect(String(res.content?.[0]?.text)).toContain("requires at least one citation");
    expect(db.select().from(walkthroughRatings).all()).toHaveLength(0);
  });

  it("advances to phase D exactly once when all nine calls arrive together", async () => {
    // The prompt asks for all nine calls in one turn, so the agent SDK may
    // dispatch them concurrently and in any order.
    const db = seed();
    const events: WalkthroughStreamEvent[] = [];
    const ctx = ctxFor(db, events);
    const results = await Promise.all(
      [...RATING_AXES]
        .reverse()
        .map((axis) =>
          rateAxisHandler(ctx, rating({ axis, verdict: "concern", citations: [CITATION] })),
        ),
    );
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(phaseOf(db)).toBe("D");
    expect(events.filter((e) => e.type === "rating")).toHaveLength(RATING_AXES.length);
    expect(events.filter((e) => e.type === "phase:advanced")).toHaveLength(1);
    expect(results.filter((r) => String(r.content?.[0]?.text).includes("Final axis"))).toHaveLength(
      1,
    );
  });

  it("advances on the ninth rationale, not the ninth row", async () => {
    // Legacy rows from the verdict pass already exist; the phase must not
    // move until the agent has written prose for every axis.
    const db = seed({ emptyRows: true });
    const ctx = ctxFor(db);
    for (const [i, axis] of RATING_AXES.entries()) {
      await rateAxisHandler(ctx, rating({ axis }));
      expect(phaseOf(db)).toBe(i === RATING_AXES.length - 1 ? "D" : "C");
    }
    // The agent's verdict replaces the seeded one.
    const verdicts = db.select({ v: walkthroughRatings.verdict }).from(walkthroughRatings).all();
    expect(verdicts.every((r) => r.v === "pass")).toBe(true);
  });
});
