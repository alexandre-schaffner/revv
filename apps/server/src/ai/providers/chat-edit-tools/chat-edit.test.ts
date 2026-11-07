import { describe, expect, it } from "bun:test";
import type { ThreadEventMessage, WalkthroughStreamEvent } from "@revv/shared";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../../db/index";
import {
  walkthroughBlocks,
  walkthroughIssues,
  walkthroughSemanticSteps,
  walkthroughs,
} from "../../../db/schema";
import { blockOrder } from "../../../services/walkthrough/content";
import { deleteSemanticStepHandler } from "./content-handlers";
import { deleteIssueHandler, updateIssueHandler } from "./review-handlers";
import type { ChatWalkthroughEditContext } from "./spec";

const WT = "wt-1";
const NOW = "2026-01-01T00:00:00Z";

function seed(): Db {
  const db = createDb(":memory:");
  (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
    "PRAGMA foreign_keys = OFF",
  );
  db.insert(walkthroughs)
    .values({
      id: WT,
      reviewSessionId: "session-1",
      pullRequestId: "pr-1",
      summary: "s",
      status: "complete",
      lastCompletedPhase: "D",
      generatedAt: NOW,
      modelUsed: "m",
      tokenUsage: "{}",
      prHeadSha: "head",
    })
    .run();
  db.insert(walkthroughSemanticSteps)
    .values({ id: "ch-1", walkthroughId: WT, semanticStepIndex: 1, title: "One", createdAt: NOW })
    .run();
  // A block imported before ids were deterministic.
  for (const [id, step] of [
    ["uuid-a", 0],
    ["uuid-b", 1],
  ] as const) {
    db.insert(walkthroughBlocks)
      .values({
        id,
        walkthroughId: WT,
        semanticStepIndex: 1,
        stepIndex: step,
        order: blockOrder(1, step),
        type: "markdown",
        data: JSON.stringify({ type: "markdown", id, content: "x" }),
        createdAt: NOW,
      })
      .run();
  }
  db.insert(walkthroughIssues)
    .values({
      id: "i-info",
      walkthroughId: WT,
      order: 0,
      severity: "info",
      title: "Nit",
      description: "d",
      blockIds: JSON.stringify(["uuid-a", "elsewhere"]),
      createdAt: NOW,
    })
    .run();
  return db;
}

function context(db: Db) {
  const published: { walkthroughId: string; events: readonly WalkthroughStreamEvent[] }[] = [];
  const threadEvents: ThreadEventMessage[] = [];
  const ctx: ChatWalkthroughEditContext = {
    db,
    prId: "pr-1",
    actor: "chat:acp",
    publishEdit: (walkthroughId, events) => published.push({ walkthroughId, events }),
    broadcastThreadEvent: (msg) => threadEvents.push(msg),
  };
  return { ctx, published, threadEvents };
}

const lastEditedBy = (db: Db) =>
  db.select().from(walkthroughs).where(eq(walkthroughs.id, WT)).get()?.lastEditedBy ?? null;

describe("chat edits", () => {
  it("publish one edit carrying every event, after stamping the row", async () => {
    const db = seed();
    const { ctx, published } = context(db);

    const result = await deleteSemanticStepHandler(ctx, { semantic_step_index: 1 });

    expect(result.isError).toBeUndefined();
    expect(lastEditedBy(db)).toBe("chat:acp");
    expect(published).toHaveLength(1);
    expect(published[0]?.events.map((e) => e.type)).toEqual([
      "block:deleted",
      "block:deleted",
      "issue",
      "semantic-step:deleted",
    ]);
    const issue = db.select().from(walkthroughIssues).get();
    expect(JSON.parse(issue?.blockIds ?? "[]")).toEqual(["elsewhere"]);
  });

  it("address blocks of an imported review by position", async () => {
    const db = seed();
    const { ctx, published } = context(db);

    await updateIssueHandler(ctx, {
      issue_id: "i-info",
      block_refs: [{ semantic_step_index: 1, step_index: 1 }],
    });

    const issue = db.select().from(walkthroughIssues).get();
    expect(JSON.parse(issue?.blockIds ?? "[]")).toEqual(["uuid-b"]);
    expect(published).toHaveLength(1);
  });

  it("leave the row untouched and publish nothing when refused", async () => {
    const db = seed();
    db.update(walkthroughIssues).set({ submittedAt: NOW }).run();
    const { ctx, published, threadEvents } = context(db);

    const result = await deleteIssueHandler(ctx, { issue_id: "i-info" });

    expect(result.isError).toBe(true);
    expect(lastEditedBy(db)).toBeNull();
    expect(published).toHaveLength(0);
    expect(threadEvents).toHaveLength(0);
  });
});
