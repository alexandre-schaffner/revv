import { describe, expect, it } from "bun:test";
import { createDb } from "../../db/index";
import { pullRequests, walkthroughIssues, walkthroughs } from "../../db/schema";
import { collectIssueGateInput } from "./issue-relevance-context";

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
