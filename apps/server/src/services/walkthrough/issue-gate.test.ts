import { describe, expect, it } from "bun:test";
import type { WalkthroughStreamEvent } from "@revv/shared";
import { createDb } from "../../db/index";
import { pullRequests, walkthroughIssues, walkthroughs } from "../../db/schema";
import { applyJudgment, collectIssueGateInput } from "./issue-gate";

const WT = "wt-1";
const PR = "repo-1:1";

function seed() {
  const db = createDb(":memory:");
  (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
    "PRAGMA foreign_keys = OFF",
  );
  const now = new Date().toISOString();
  db.insert(pullRequests)
    .values({
      id: PR,
      externalId: 1,
      repositoryId: "repo-1",
      title: "Retry requests",
      authorLogin: "alex",
      sourceBranch: "feat/retry",
      targetBranch: "main",
      url: "https://github.com/acme/widgets/pull/1",
      createdAt: now,
      updatedAt: now,
      fetchedAt: now,
    })
    .run();
  db.insert(walkthroughs)
    .values({
      id: WT,
      reviewSessionId: "session-1",
      pullRequestId: PR,
      status: "generating",
      generatedAt: now,
      modelUsed: "test",
      tokenUsage: "{}",
      prHeadSha: "deadbeef",
    })
    .run();
  const issue = (id: string, order: number, title: string) =>
    db
      .insert(walkthroughIssues)
      .values({
        id,
        walkthroughId: WT,
        order,
        severity: "warning",
        title,
        description: `${title}.`,
        filePath: null,
        startLine: null,
        endLine: null,
        blockIds: "[]",
        createdAt: now,
      })
      .run();
  issue("i1", 0, "Requests are not retried");
  issue("i2", 1, "Timeouts are too short");
  return db;
}

describe("collectIssueGateInput", () => {
  // flag_issue writes the concern before it is judged, so it would otherwise
  // match itself as a duplicate.
  it("leaves the judged issue out of the issues it might duplicate", () => {
    const input = collectIssueGateInput(seed(), WT, "i2", {
      severity: "warning",
      title: "Timeouts are too short",
      description: "Timeouts are too short.",
      filePath: null,
      startLine: null,
      endLine: null,
    });

    expect(input?.existingIssues.map((i) => i.title)).toEqual(["Requests are not retried"]);
  });
});

describe("applyJudgment", () => {
  // The web replaces its copy of an issue with the event's, so a payload
  // without the resolution would reopen a resolved concern on screen.
  it("broadcasts the whole committed issue, resolution included", () => {
    const db = createDb(":memory:");
    (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
      "PRAGMA foreign_keys = OFF",
    );
    const candidate = {
      severity: "warning" as const,
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
