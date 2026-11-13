import { describe, expect, it } from "bun:test";
import { createDb, type Db } from "../../db/index";
import { walkthroughs } from "../../db/schema";
import { perspectiveOf } from "./perspective";

function insertWalkthroughs(
  db: Db,
  ...rows: readonly (Partial<typeof walkthroughs.$inferInsert> & { id: string })[]
): void {
  db.$client.run("PRAGMA foreign_keys = OFF");
  for (const row of rows) {
    db.insert(walkthroughs)
      .values({
        reviewSessionId: "session-1",
        pullRequestId: "pr-1",
        generatedAt: "2026-01-01T00:00:00Z",
        modelUsed: "test-model",
        prHeadSha: "head-1",
        ...row,
      })
      .run();
  }
}

describe("perspectiveOf", () => {
  it("is the identity-derived one when the PR has no walkthrough", () => {
    expect(perspectiveOf(createDb(":memory:"), "pr-1")).toBe("reviewer");
  });

  it("follows the newest row, whatever its perspective", () => {
    const db = createDb(":memory:");
    insertWalkthroughs(
      db,
      { id: "a", mode: "author", status: "complete", generatedAt: "2026-01-01T00:00:00Z" },
      { id: "b", mode: "reviewer", status: "generating", generatedAt: "2026-01-02T00:00:00Z" },
    );
    expect(perspectiveOf(db, "pr-1")).toBe("reviewer");
  });

  it("counts superseded rows, so a stale walkthrough keeps its perspective", () => {
    const db = createDb(":memory:");
    insertWalkthroughs(
      db,
      { id: "a", mode: "reviewer", status: "complete", generatedAt: "2026-01-01T00:00:00Z" },
      { id: "b", mode: "author", status: "superseded", generatedAt: "2026-01-02T00:00:00Z" },
    );
    expect(perspectiveOf(db, "pr-1")).toBe("author");
  });
});
