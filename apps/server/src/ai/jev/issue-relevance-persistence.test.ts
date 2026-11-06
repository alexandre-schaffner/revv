import { describe, expect, it } from "bun:test";
import type { WalkthroughStreamEvent } from "@revv/shared";
import { createDb } from "../../db/index";
import { walkthroughIssues } from "../../db/schema";
import { applyJudgment } from "./issue-relevance-persistence";

describe("applyJudgment", () => {
  // The web replaces its copy of an issue with the event's, so a payload
  // without the resolution would reopen a resolved concern on screen.
  it("broadcasts the whole committed issue, resolution included", () => {
    const db = createDb(":memory:");
    (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
      "PRAGMA foreign_keys = OFF",
    );
    const candidate = {
      severity: "warning",
      title: "Retry failures",
      description: "The request is not retried.",
      filePath: "src/request.ts",
      startLine: 12,
      endLine: 14,
    };
    db.insert(walkthroughIssues)
      .values({
        id: "i1",
        walkthroughId: "wt",
        order: 0,
        ...candidate,
        blockIds: JSON.stringify(["b1"]),
        createdAt: "2026-01-01T00:00:00Z",
        resolutionStatus: "addressed",
        resolutionExplanation: "Retried in the client.",
        resolutionEvidence: JSON.stringify(["src/client.ts"]),
        resolvedAt: "2026-01-02T00:00:00Z",
        resolvedBy: "codex",
      })
      .run();

    const events: WalkthroughStreamEvent[] = [];
    applyJudgment(
      db,
      "wt",
      "i1",
      candidate,
      { score: 0.9, lowSignal: false, discard: false, severity: "critical" },
      { emit: (event) => events.push(event), broadcastThread: () => {}, markRetracted: () => {} },
    );

    expect(events).toHaveLength(1);
    const [event] = events;
    if (event?.type !== "issue") throw new Error("expected an issue event");
    expect(event.data).toMatchObject({
      id: "i1",
      severity: "critical",
      advisoryScore: 0.9,
      blockIds: ["b1"],
      resolutionStatus: "addressed",
      resolutionExplanation: "Retried in the client.",
      resolutionEvidence: ["src/client.ts"],
      resolvedBy: "codex",
    });
  });
});
