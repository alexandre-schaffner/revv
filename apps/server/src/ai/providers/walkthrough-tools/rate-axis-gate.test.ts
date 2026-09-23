import { describe, expect, it } from "bun:test";
import type { AxisAdvisoryState, WalkthroughStreamEvent } from "@revv/shared";
import { RATING_AXES } from "@revv/shared";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../../db/index";
import { walkthroughRatings, walkthroughs } from "../../../db/schema";
import { rateAxisHandler } from "./index";
import type { RateAxisInput, WalkthroughToolContext } from "./spec";

const WT = "wt-1";

function seed(state: AxisAdvisoryState | null, opts: { seedVerdicts?: boolean } = {}): Db {
  const db = createDb(":memory:");
  // Only the two tables under test are seeded; the walkthrough's PR and
  // review-session parents are irrelevant to the gate.
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
      axisAdvisoryState: state,
    })
    .run();
  if (opts.seedVerdicts) {
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
          verdictSource: "advisory",
          verdictConfidence: 0.9,
          createdAt: now,
        })
        .run();
    }
  }
  return db;
}

function ctxFor(db: Db): WalkthroughToolContext {
  const events: WalkthroughStreamEvent[] = [];
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

describe("rate_axis advisory gate", () => {
  it("rejects retryably while the verdict pass is in flight", async () => {
    const db = seed("pending");
    const res = await rateAxisHandler(ctxFor(db), rating());
    expect(res.isError).toBe(true);
    expect(String(res.content?.[0]?.text)).toContain("still being computed");
    // Nothing was written — the agent's retry is a clean replay.
    expect(db.select().from(walkthroughRatings).all()).toHaveLength(0);
  });

  it("takes the agent's verdict when no pass ran", async () => {
    const db = seed(null);
    const res = await rateAxisHandler(ctxFor(db), rating({ axis: "tests", verdict: "pass" }));
    expect(res.isError).toBeFalsy();
    const row = db
      .select()
      .from(walkthroughRatings)
      .where(eq(walkthroughRatings.axis, "tests"))
      .get();
    expect(row?.verdict).toBe("pass");
    expect(row?.verdictSource).toBe("agent");
  });

  it("keeps the pre-assigned verdict and ignores the agent's", async () => {
    const db = seed("ready", { seedVerdicts: true });
    const res = await rateAxisHandler(
      ctxFor(db),
      // The seeded verdict is `concern`; the agent sends `pass`.
      rating({
        axis: "scope",
        verdict: "pass",
        citations: [{ file_path: "a.ts", start_line: 1, end_line: 2, note: null }],
      }),
    );
    expect(res.isError).toBeFalsy();
    const row = db
      .select()
      .from(walkthroughRatings)
      .where(eq(walkthroughRatings.axis, "scope"))
      .get();
    expect(row?.verdict).toBe("concern");
    expect(row?.verdictSource).toBe("advisory");
    expect(row?.rationale).toBe(rating().rationale);
  });

  it("accepts a disputed non-pass axis with no citation", async () => {
    const db = seed("ready", { seedVerdicts: true });
    const res = await rateAxisHandler(
      ctxFor(db),
      rating({ axis: "safety", citations: [], disputed: true }),
    );
    expect(res.isError).toBeFalsy();
    const row = db
      .select()
      .from(walkthroughRatings)
      .where(eq(walkthroughRatings.axis, "safety"))
      .get();
    // The dispute is recorded and the verdict stands.
    expect(row?.disputed).toBe(true);
    expect(row?.verdict).toBe("concern");
  });

  it("rejects a disputed uncited axis when no pass ran", async () => {
    // The hatch relieves a deadlock only for a verdict the agent didn't
    // choose; on the agent-authored path it can downgrade to `pass` instead,
    // so `disputed` must not become a citation bypass.
    const db = seed(null);
    const res = await rateAxisHandler(
      ctxFor(db),
      rating({ axis: "safety", verdict: "concern", citations: [], disputed: true }),
    );
    expect(res.isError).toBe(true);
    expect(String(res.content?.[0]?.text)).toContain("requires at least one citation");
  });

  it("drops disputed on the agent-authored path rather than recording it", async () => {
    // Nothing to disagree with when the agent picked the verdict itself.
    const db = seed(null);
    const res = await rateAxisHandler(
      ctxFor(db),
      rating({
        axis: "safety",
        verdict: "concern",
        citations: [{ file_path: "a.ts", start_line: 1, end_line: 2, note: null }],
        disputed: true,
      }),
    );
    expect(res.isError).toBeFalsy();
    const row = db
      .select()
      .from(walkthroughRatings)
      .where(eq(walkthroughRatings.axis, "safety"))
      .get();
    expect(row?.disputed).toBe(false);
  });

  it("still rejects an uncited non-pass axis that isn't disputed", async () => {
    const db = seed("ready", { seedVerdicts: true });
    const res = await rateAxisHandler(ctxFor(db), rating({ axis: "safety", citations: [] }));
    expect(res.isError).toBe(true);
    expect(String(res.content?.[0]?.text)).toContain("disputed=true");
  });

  it("advances to phase D on the ninth rationale, not the ninth row", async () => {
    const db = seed("ready", { seedVerdicts: true });
    const ctx = ctxFor(db);
    // Nine rows already exist from the pass. The phase must not move until
    // the agent has written prose for every one of them.
    for (const [i, axis] of RATING_AXES.entries()) {
      await rateAxisHandler(
        ctx,
        rating({
          axis,
          citations: [{ file_path: "a.ts", start_line: 1, end_line: 2, note: null }],
        }),
      );
      const phase = db
        .select({ p: walkthroughs.lastCompletedPhase })
        .from(walkthroughs)
        .where(eq(walkthroughs.id, WT))
        .get()?.p;
      expect(phase).toBe(i === RATING_AXES.length - 1 ? "D" : "C");
    }
  });
});
