import { describe, expect, it } from "bun:test";
import type { WalkthroughStackSnapshot } from "@revv/shared";
import { createDb, type Db } from "../../../db/index";
import { prDiffFiles, pullRequests, walkthroughIssues, walkthroughs } from "../../../db/schema";
import { TOOL_SPECS } from "./index";
import { getStackContextHandler } from "./read-handler";
import type { WalkthroughToolContext } from "./spec";

const NOW = "2026-10-16T00:00:00Z";

type Client = { session: { client: { run: (sql: string) => void } } };

const STACK: WalkthroughStackSnapshot = {
  number: 7,
  baseRefName: "main",
  position: 2,
  layers: [
    {
      position: 1,
      number: 120,
      title: "Add the store",
      headSha: "a",
      baseRef: "main",
      status: "merged",
    },
    {
      position: 2,
      number: 121,
      title: "Add a limiter",
      headSha: "b",
      baseRef: "a",
      status: "ready",
    },
    {
      position: 3,
      number: 122,
      title: "Wire it (stale title)",
      headSha: "c",
      baseRef: "b",
      status: "draft",
    },
    {
      position: 4,
      number: 123,
      title: "Untracked top",
      headSha: "d",
      baseRef: "c",
      status: "ready",
    },
  ],
  capturedAt: NOW,
};

function pr(db: Db, id: string, number: number, title: string, body: string | null = null) {
  db.insert(pullRequests)
    .values({
      id,
      externalId: number,
      repositoryId: "repo-1",
      title,
      body,
      authorLogin: "a",
      sourceBranch: `b${number}`,
      targetBranch: "main",
      url: `https://github.com/o/r/pull/${number}`,
      createdAt: NOW,
      updatedAt: NOW,
      fetchedAt: NOW,
    })
    .run();
}

function wt(db: Db, id: string, prId: string, extra: Partial<typeof walkthroughs.$inferInsert>) {
  db.insert(walkthroughs)
    .values({
      id,
      reviewSessionId: "s",
      pullRequestId: prId,
      generatedAt: NOW,
      modelUsed: "test",
      tokenUsage: "{}",
      prHeadSha: "x",
      ...extra,
    })
    .run();
}

function seed(stackContext: string | null): Db {
  const db = createDb(":memory:");
  (db as unknown as Client).session.client.run("PRAGMA foreign_keys = OFF");
  pr(db, "pr-120", 120, "Add the store");
  pr(db, "pr-121", 121, "Add a limiter");
  pr(db, "pr-122", 122, "Wire the limiter", `Uses the limiter. ${"x".repeat(700)}`);
  wt(db, "wt-121", "pr-121", { status: "generating", stackContext });
  wt(db, "wt-120", "pr-120", {
    status: "superseded",
    lastCompletedPhase: "D",
    completedAt: NOW,
    summary: "**Adds a token store** for the limiter.\n\nContext: …",
  });
  for (let i = 0; i < 10; i++) {
    db.insert(walkthroughIssues)
      .values({
        id: `i-${i}`,
        walkthroughId: "wt-120",
        order: i,
        severity: i === 0 ? "critical" : "info",
        title: `Issue ${i}`,
        description: "d",
        resolutionStatus: i === 9 ? "resolved" : "open",
        createdAt: NOW,
      })
      .run();
  }
  for (const path of ["src/wire.ts", "src/app.ts"]) {
    db.insert(prDiffFiles)
      .values({ id: `pr-122\0${path}`, prId: "pr-122", path, status: "modified", fetchedAt: NOW })
      .run();
  }
  return db;
}

function ctx(db: Db): WalkthroughToolContext {
  return {
    db,
    walkthroughId: "wt-121",
    emit: () => {},
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

async function read(db: Db) {
  const result = await getStackContextHandler(ctx(db), {});
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("get_stack_context", () => {
  it("is registered on the shared tool surface both transports read", () => {
    expect(TOOL_SPECS.map((s) => s.name)).toContain("get_stack_context");
  });

  it("joins the captured stack with the other layers' live state", async () => {
    const out = await read(seed(JSON.stringify(STACK)));
    expect(out.stack.number).toBe(7);

    expect(out.lowerLayers).toHaveLength(1);
    const [below] = out.lowerLayers;
    expect(below.number).toBe(120);
    expect(below.review.takeaway).toBe("Adds a token store for the limiter.");
    expect(below.review.openIssueCount).toBe(9);
    expect(below.review.openIssues).toHaveLength(8);
    expect(below.review.openIssues[0]).toEqual({ title: "Issue 0", severity: "critical" });

    const [above, top] = out.upperLayers;
    expect(above.title).toBe("Wire the limiter");
    expect(above.bodyExcerpt.length).toBe(601);
    expect(above.files).toEqual(["src/app.ts", "src/wire.ts"]);
    expect(top).toEqual({
      position: 4,
      number: 123,
      status: "ready",
      title: "Untracked top",
      tracked: false,
      files: null,
    });
  });

  it("says so when the PR isn't stacked", async () => {
    const out = await read(seed(null));
    expect(out.stack).toBeNull();
    expect(out.instructions).toContain("not part of a stack");
  });
});
