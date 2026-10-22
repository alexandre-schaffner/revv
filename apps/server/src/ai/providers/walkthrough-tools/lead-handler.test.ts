import { describe, expect, it } from "bun:test";
import type { WalkthroughPipelinePhase, WalkthroughStreamEvent } from "@revv/shared";
import { RATING_AXES } from "@revv/shared";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../../db/index";
import {
  commentThreads,
  walkthroughBlocks,
  walkthroughIssues,
  walkthroughLeads,
  walkthroughRatings,
  walkthroughSemanticSteps,
  walkthroughs,
} from "../../../db/schema";
import { loadWalkthroughLeads, recordWalkthroughLeads } from "../../../services/walkthrough-leads";
import { completeWalkthroughHandler, TOOL_SPECS } from "./index";
import { resolveLeadHandler } from "./lead-handler";
import { getWalkthroughStateHandler } from "./read-handler";
import type { ResolveLeadInput, WalkthroughToolContext } from "./spec";

const WT = "wt-1";
const NOW = new Date().toISOString();

type Client = { session: { client: { run: (sql: string) => void } } };

function foreignKeys(db: Db, on: boolean): void {
  (db as unknown as Client).session.client.run(`PRAGMA foreign_keys = ${on ? "ON" : "OFF"}`);
}

const lead = (filePath: string, hunkIndex: number, newStart: number) => ({
  filePath,
  hunkIndex,
  newStart,
  newLines: 4,
  smells: [{ smell: "verbose_comment" as const, probability: 0.7 }],
});

function seed(phase: WalkthroughPipelinePhase = "B"): Db {
  const db = createDb(":memory:");
  // The walkthrough's PR and review-session parents are irrelevant here.
  foreignKeys(db, false);
  db.insert(walkthroughs)
    .values({
      id: WT,
      reviewSessionId: "session-1",
      pullRequestId: "repo-1:1",
      mode: "author",
      summary: "a summary",
      sentiment: "a sentiment",
      status: "generating",
      lastCompletedPhase: phase,
      generatedAt: NOW,
      modelUsed: "test",
      tokenUsage: "{}",
      prHeadSha: "deadbeef",
    })
    .run();
  db.insert(walkthroughIssues)
    .values({
      id: "issue-a",
      walkthroughId: WT,
      order: 0,
      severity: "info",
      title: "Comment restates the code",
      description: "Trim the comment.",
      filePath: "src/a.ts",
      startLine: 10,
      endLine: 12,
      createdAt: NOW,
    })
    .run();
  recordWalkthroughLeads(db, WT, [lead("src/a.ts", 0, 10), lead("src/b.ts", 2, 40)]);
  return db;
}

/** Everything `complete_walkthrough` checks besides the leads. */
function seedFinished(db: Db): void {
  db.insert(commentThreads)
    .values({
      id: "thread-a",
      reviewSessionId: "session-1",
      filePath: "src/a.ts",
      startLine: 10,
      endLine: 12,
      walkthroughIssueId: "issue-a",
      createdAt: NOW,
    })
    .run();
  db.insert(walkthroughSemanticSteps)
    .values({
      id: "ss-0",
      walkthroughId: WT,
      semanticStepIndex: 0,
      title: "Comments",
      createdAt: NOW,
    })
    .run();
  db.insert(walkthroughBlocks)
    .values({
      id: "b-0",
      walkthroughId: WT,
      semanticStepIndex: 0,
      order: 0,
      stepIndex: 0,
      type: "markdown",
      data: "{}",
      createdAt: NOW,
    })
    .run();
  for (const axis of RATING_AXES) {
    db.insert(walkthroughRatings)
      .values({
        id: `r-${axis}`,
        walkthroughId: WT,
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

function ctxFor(
  db: Db,
  events: WalkthroughStreamEvent[] = [],
  retracted: ReadonlySet<string> = new Set(),
): WalkthroughToolContext {
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
      issueRetracted: (id) => retracted.has(id),
      judgeArtifact: () => Promise.resolve({ failed: [], reject: false }),
      scheduleProseCheck: () => {},
      takeProseAdvice: () => null,
    },
  };
}

const text = (r: { content: Array<{ text: string }> }) => r.content[0]?.text ?? "";

async function resolve(db: Db, input: ResolveLeadInput, ctx = ctxFor(db)) {
  return resolveLeadHandler(ctx, input);
}

describe("recordWalkthroughLeads", () => {
  it("numbers the leads in order and stamps the selection", () => {
    const db = seed();
    const leads = loadWalkthroughLeads(db, WT, "set");
    expect(leads?.map((l) => [l.id, l.filePath, l.verdict])).toEqual([
      ["L1", "src/a.ts", null],
      ["L2", "src/b.ts", null],
    ]);
    const row = db.select().from(walkthroughs).where(eq(walkthroughs.id, WT)).get();
    expect(row?.leadsSelectedAt).not.toBeNull();
  });

  it("keeps the first selection on a resume, verdicts included", async () => {
    const db = seed();
    await resolve(db, { lead_id: "L2", verdict: "rejected", reason: "The caller checks it." });
    const again = recordWalkthroughLeads(db, WT, [lead("src/c.ts", 0, 1)]);
    expect(again.map((l) => [l.id, l.filePath, l.verdict])).toEqual([
      ["L1", "src/a.ts", null],
      ["L2", "src/b.ts", "rejected"],
    ]);
  });

  it("records an empty selection, which reads as no leads rather than unknown", () => {
    const db = createDb(":memory:");
    foreignKeys(db, false);
    db.insert(walkthroughs)
      .values({
        id: WT,
        reviewSessionId: "s",
        pullRequestId: "p",
        status: "generating",
        generatedAt: NOW,
        modelUsed: "test",
        tokenUsage: "{}",
        prHeadSha: "x",
      })
      .run();
    expect(loadWalkthroughLeads(db, WT, null)).toBeNull();
    expect(recordWalkthroughLeads(db, WT, [])).toEqual([]);
    const row = db.select().from(walkthroughs).where(eq(walkthroughs.id, WT)).get();
    expect(loadWalkthroughLeads(db, WT, row?.leadsSelectedAt ?? null)).toEqual([]);
  });
});

describe("resolve_lead", () => {
  it("is on the tool surface", () => {
    expect(TOOL_SPECS.map((s) => s.name)).toContain("resolve_lead");
  });

  it("confirms a lead against its issue and broadcasts it", async () => {
    const db = seed();
    const events: WalkthroughStreamEvent[] = [];
    const out = await resolve(
      db,
      { lead_id: "L1", verdict: "confirmed", issue_id: "issue-a" },
      ctxFor(db, events),
    );
    expect(out.isError).toBeUndefined();
    expect(text(out)).toContain("1 lead(s) still need a verdict");
    expect(events).toEqual([
      {
        type: "lead",
        data: expect.objectContaining({ id: "L1", verdict: "confirmed", issueId: "issue-a" }),
      },
    ]);
  });

  it("rejects with a reason, and a later call replaces the verdict", async () => {
    const db = seed();
    await resolve(db, { lead_id: "L1", verdict: "rejected", reason: "It is a license header." });
    const out = await resolve(db, { lead_id: "L1", verdict: "confirmed", issue_id: "issue-a" });
    expect(out.isError).toBeUndefined();
    const [first] = loadWalkthroughLeads(db, WT, "set") ?? [];
    expect(first).toMatchObject({ verdict: "confirmed", issueId: "issue-a", reason: null });
  });

  it("refuses a malformed verdict without writing it", async () => {
    const db = seed();
    const cases: ResolveLeadInput[] = [
      { lead_id: "L1", verdict: "rejected" },
      { lead_id: "L1", verdict: "rejected", reason: "   " },
      { lead_id: "L1", verdict: "confirmed" },
      { lead_id: "L1", verdict: "confirmed", issue_id: "nope" },
      // issue-a is in src/a.ts; L2 is in src/b.ts.
      { lead_id: "L2", verdict: "confirmed", issue_id: "issue-a" },
      { lead_id: "L9", verdict: "rejected", reason: "x" },
    ];
    for (const input of cases) {
      expect((await resolve(db, input)).isError).toBe(true);
    }
    expect(loadWalkthroughLeads(db, WT, "set")?.every((l) => l.verdict === null)).toBe(true);
  });

  it("needs the overview first", async () => {
    const db = seed("none");
    const out = await resolve(db, { lead_id: "L1", verdict: "rejected", reason: "x" });
    expect(out.isError).toBe(true);
  });

  it("records a confirmation whose issue was withdrawn, unlinked and without error", async () => {
    const db = seed();
    const out = await resolve(
      db,
      { lead_id: "L1", verdict: "confirmed", issue_id: "issue-gone" },
      ctxFor(db, [], new Set(["issue-gone"])),
    );
    expect(out.isError).toBeUndefined();
    expect(text(out)).toContain("withdrawn");
    const [first] = loadWalkthroughLeads(db, WT, "set") ?? [];
    expect(first).toMatchObject({ verdict: "confirmed", issueId: null });
  });

  it("unlinks a confirmed lead when its issue is deleted later", async () => {
    const db = seed();
    await resolve(db, { lead_id: "L1", verdict: "confirmed", issue_id: "issue-a" });
    foreignKeys(db, true);
    db.delete(walkthroughIssues).where(eq(walkthroughIssues.id, "issue-a")).run();
    const row = db.select().from(walkthroughLeads).where(eq(walkthroughLeads.leadKey, "L1")).get();
    expect(row).toMatchObject({ verdict: "confirmed", issueId: null });
  });
});

describe("complete_walkthrough and get_walkthrough_state", () => {
  it("lists the leads still owed a verdict", async () => {
    const db = seed();
    await resolve(db, { lead_id: "L1", verdict: "confirmed", issue_id: "issue-a" });
    const out = text(await getWalkthroughStateHandler(ctxFor(db), {}));
    expect(out).toContain("1 first-pass lead(s) have no verdict yet (L2)");
    const state = JSON.parse(out.slice(out.indexOf("{"))) as { leadsNeedingVerdict: string[] };
    expect(state.leadsNeedingVerdict).toEqual(["L2"]);
  });

  it("refuses to complete until every lead is resolved", async () => {
    const db = seed("D");
    seedFinished(db);
    const refused = await completeWalkthroughHandler(ctxFor(db), {});
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("L1 (src/a.ts:10), L2 (src/b.ts:40)");

    await resolve(db, { lead_id: "L1", verdict: "confirmed", issue_id: "issue-a" });
    await resolve(db, { lead_id: "L2", verdict: "rejected", reason: "The guard is reachable." });
    const done = await completeWalkthroughHandler(ctxFor(db), {});
    expect(done.isError).toBeUndefined();
  });
});
