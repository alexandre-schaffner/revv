import { describe, expect, it } from "bun:test";
import { RATING_AXES } from "@revv/shared";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../db/index";
import {
  walkthroughBlocks,
  walkthroughLeads,
  walkthroughRatings,
  walkthroughSemanticSteps,
  walkthroughs,
} from "../../db/schema";
import { orchestratorCompletionBlocker, walkthroughCompletionBlockers } from "./completion";

const NOW = "2026-11-01T00:00:00Z";
const ID = "wt-1";

type Client = { session: { client: { run: (sql: string) => void } } };

/** A reviewer walkthrough's journal as a crash left it, up to `upTo`. */
function seed(db: Db, upTo: "B" | "D"): void {
  (db as unknown as Client).session.client.run("PRAGMA foreign_keys = OFF");
  db.insert(walkthroughs)
    .values({
      id: ID,
      reviewSessionId: "session-1",
      pullRequestId: "pr-1",
      generatedAt: NOW,
      modelUsed: "m",
      tokenUsage: "{}",
      prHeadSha: "head-1",
      status: "generating",
      summary: "Adds a limiter.",
      lastCompletedPhase: upTo,
      ...(upTo === "D" ? { sentiment: "Ship it." } : {}),
    })
    .run();
  db.insert(walkthroughSemanticSteps)
    .values({
      id: "ss-0",
      walkthroughId: ID,
      semanticStepIndex: 0,
      title: "How we got here",
      createdAt: NOW,
    })
    .run();
  db.insert(walkthroughBlocks)
    .values({
      id: "b-0",
      walkthroughId: ID,
      semanticStepIndex: 0,
      order: 0,
      stepIndex: 0,
      type: "markdown",
      data: JSON.stringify({ type: "markdown", content: "The journey." }),
      createdAt: NOW,
    })
    .run();
  if (upTo !== "D") return;
  for (const axis of RATING_AXES) {
    db.insert(walkthroughRatings)
      .values({
        id: `r-${axis}`,
        walkthroughId: ID,
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

function addUnresolvedLead(db: Db): void {
  db.insert(walkthroughLeads)
    .values({
      id: "lead-1",
      walkthroughId: ID,
      leadKey: "L1",
      ordinal: 1,
      filePath: "src/a.ts",
      hunkIndex: 0,
      newStart: 1,
      newLines: 3,
      smells: "[]",
    })
    .run();
}

// After a kill -9, resume asks the same question of the journal that the
// agent's gate asks: is this walkthrough finished?
describe("walkthrough completion check", () => {
  it("blocks a journal cut off mid-phase, for the gate and the orchestrator alike", () => {
    const db = createDb(":memory:");
    seed(db, "B");
    expect(walkthroughCompletionBlockers(db, ID)[0]?.scope).toBe("hard");
    expect(orchestratorCompletionBlocker(db, ID)).toContain("Phase D");
  });

  it("passes a finished journal", () => {
    const db = createDb(":memory:");
    seed(db, "D");
    expect(walkthroughCompletionBlockers(db, ID)).toEqual([]);
    expect(orchestratorCompletionBlocker(db, ID)).toBeNull();
  });

  it("holds the gate on an unresolved lead but lets the orchestrator complete", () => {
    const db = createDb(":memory:");
    seed(db, "D");
    addUnresolvedLead(db);
    expect(walkthroughCompletionBlockers(db, ID)).toEqual([
      expect.objectContaining({ scope: "gate-only" }),
    ]);
    expect(orchestratorCompletionBlocker(db, ID)).toBeNull();
  });

  it("refuses a phase-D journal the gate would refuse", () => {
    const db = createDb(":memory:");
    seed(db, "D");
    db.update(walkthroughSemanticSteps)
      .set({ title: "Limiter" })
      .where(eq(walkthroughSemanticSteps.id, "ss-0"))
      .run();
    expect(orchestratorCompletionBlocker(db, ID)).toContain("journey chapter");
    db.update(walkthroughSemanticSteps)
      .set({ title: "How we got here" })
      .where(eq(walkthroughSemanticSteps.id, "ss-0"))
      .run();
    db.update(walkthroughRatings)
      .set({ rationale: "" })
      .where(eq(walkthroughRatings.id, "r-tests"))
      .run();
    expect(orchestratorCompletionBlocker(db, ID)).toContain("missing ratings for [tests]");
  });
});
