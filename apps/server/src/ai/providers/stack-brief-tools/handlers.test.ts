import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../../db/index";
import { prDiffFiles } from "../../../db/schema/pr-diff-files";
import { stackBriefLayers, stackBriefs } from "../../../db/schema/stack-briefs";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import {
  completeStackBriefHandler,
  getStackBriefStateHandler,
  getStackLayersHandler,
  setArcHandler,
  setLayerRoleHandler,
} from "./handlers";
import type { StackBriefSnapshot, StackBriefToolContext } from "./spec";

const BRIEF = "brief-1";

const SNAPSHOT: StackBriefSnapshot = {
  stackNumber: 7,
  baseRefName: "main",
  layers: [
    {
      position: 2,
      number: 121,
      title: "Schema",
      headSha: "aaa",
      status: "ready",
      prId: "repo-1:121",
      additions: 10,
      deletions: 0,
      changedFiles: 2,
      body: null,
    },
    {
      position: 3,
      number: 122,
      title: "Route",
      headSha: "bbb",
      status: "draft",
      prId: null,
      additions: 5,
      deletions: 1,
      changedFiles: 1,
      body: "Serves it.",
    },
  ],
  merged: [{ number: 120, title: "Groundwork" }],
  capturedAt: "2026-10-16T00:00:00.000Z",
};

function seed(status = "generating"): Db {
  const db = createDb(":memory:");
  // The brief's repository parent is irrelevant to the tools.
  (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
    "PRAGMA foreign_keys = OFF",
  );
  db.insert(stackBriefs)
    .values({
      id: BRIEF,
      repositoryId: "repo-1",
      stackNumber: 7,
      signature: "sig",
      stackSnapshot: JSON.stringify(SNAPSHOT),
      status,
      userId: "u",
      createdAt: new Date().toISOString(),
    })
    .run();
  return db;
}

function ctxFor(db: Db, completed: { count: number } = { count: 0 }): StackBriefToolContext {
  return {
    db,
    briefId: BRIEF,
    onCompleted: () => {
      completed.count++;
    },
  };
}

function brief(db: Db) {
  const row = db.select().from(stackBriefs).where(eq(stackBriefs.id, BRIEF)).get();
  if (!row) throw new Error("brief missing");
  return row;
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? "";
}

const role = (position: number) => ({
  position,
  role: `Layer ${position} lays the groundwork.`,
  review_focus: `The migration default in layer ${position}.`,
  chapter: "Storage",
  builds_on: [] as { number: number; uses: string }[],
});

describe("set_layer_role", () => {
  it("advances to phase L only once every layer has a role", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    expect((await setLayerRoleHandler(ctx, role(2))).isError).toBeUndefined();
    expect(brief(db).lastCompletedPhase).toBe("none");
    const last = await setLayerRoleHandler(ctx, role(3));
    expect(text(last)).toContain("call set_arc");
    expect(brief(db).lastCompletedPhase).toBe("L");
  });

  it("is a no-op on replay", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    await setLayerRoleHandler(ctx, role(2));
    const before = db.select().from(stackBriefLayers).all();
    await setLayerRoleHandler(ctx, role(2));
    expect(db.select().from(stackBriefLayers).all()).toEqual(before);
  });

  it("overwrites in place on a changed line", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    await setLayerRoleHandler(ctx, role(2));
    await setLayerRoleHandler(ctx, { ...role(2), role: "Something sharper." });
    const rows = db.select().from(stackBriefLayers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("Something sharper.");
    expect(rows[0]?.prNumber).toBe(121);
  });

  it("rejects a position outside the snapshot, merged layers included", async () => {
    const db = seed();
    const result = await setLayerRoleHandler(ctxFor(db), role(1));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Valid positions: 2 (#121), 3 (#122)");
    expect(db.select().from(stackBriefLayers).all()).toHaveLength(0);
  });

  it("rejects multi-line, blank and overlong lines", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    expect((await setLayerRoleHandler(ctx, { ...role(2), role: "one\ntwo" })).isError).toBe(true);
    expect((await setLayerRoleHandler(ctx, { ...role(2), review_focus: "   " })).isError).toBe(
      true,
    );
    expect((await setLayerRoleHandler(ctx, { ...role(2), role: "x".repeat(241) })).isError).toBe(
      true,
    );
    expect(db.select().from(stackBriefLayers).all()).toHaveLength(0);
  });

  it("refuses once the brief is no longer generating", async () => {
    const db = seed("superseded");
    const result = await setLayerRoleHandler(ctxFor(db), role(2));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("status=superseded");
  });
});

describe("set_arc", () => {
  const arc = { arc_markdown: "#121 lays the schema; #122 serves it.", review_order: [121, 122] };

  it("refuses before every layer has a role, naming the missing ones", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    await setLayerRoleHandler(ctx, role(2));
    const result = await setArcHandler(ctx, arc);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("#122 (position 3)");
    expect(brief(db).arc).toBe("");
  });

  it("requires review_order to be a permutation of the open layers", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    await setLayerRoleHandler(ctx, role(2));
    await setLayerRoleHandler(ctx, role(3));
    for (const review_order of [[121], [121, 121], [121, 122, 120], [120, 122]]) {
      expect((await setArcHandler(ctx, { ...arc, review_order })).isError).toBe(true);
    }
    expect(brief(db).lastCompletedPhase).toBe("L");
  });

  it("rejects an arc over the limit", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    await setLayerRoleHandler(ctx, role(2));
    await setLayerRoleHandler(ctx, role(3));
    const result = await setArcHandler(ctx, { ...arc, arc_markdown: "x".repeat(901) });
    expect(result.isError).toBe(true);
  });

  it("writes the arc, advances to R, and replays as a no-op", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    await setLayerRoleHandler(ctx, role(2));
    await setLayerRoleHandler(ctx, role(3));
    await setArcHandler(ctx, { ...arc, review_order: [122, 121] });
    const after = brief(db);
    expect(after.lastCompletedPhase).toBe("R");
    expect(after.reviewOrder).toBe("[122,121]");
    expect(text(await setArcHandler(ctx, { ...arc, review_order: [122, 121] }))).toContain(
      "already stored",
    );
    expect(brief(db)).toEqual(after);
  });

  it("keeps phase R when a role is rewritten afterwards", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    await setLayerRoleHandler(ctx, role(2));
    await setLayerRoleHandler(ctx, role(3));
    await setArcHandler(ctx, arc);
    await setLayerRoleHandler(ctx, { ...role(3), role: "Rewritten." });
    expect(brief(db).lastCompletedPhase).toBe("R");
  });
});

describe("set_layer_role chapters and links", () => {
  it("stores the chapter and the lower layers a layer builds on", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    const links = [
      { number: 121, uses: "the `ApiCredential` table" },
      { number: 120, uses: "the explicit role model" },
    ];
    await setLayerRoleHandler(ctx, { ...role(3), builds_on: links });
    const row = db.select().from(stackBriefLayers).get();
    expect(row?.chapter).toBe("Storage");
    expect(JSON.parse(row?.buildsOn ?? "[]")).toEqual(links);
  });

  it("refuses a link to a layer that isn't below, twice, or too many", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    const up = await setLayerRoleHandler(ctx, {
      ...role(2),
      builds_on: [{ number: 122, uses: "x" }],
    });
    expect(up.isError).toBe(true);
    expect(text(up)).toContain("isn't below");
    const twice = [
      { number: 120, uses: "a" },
      { number: 120, uses: "b" },
    ];
    expect((await setLayerRoleHandler(ctx, { ...role(3), builds_on: twice })).isError).toBe(true);
    const many = [120, 121, 120, 121].map((number) => ({ number, uses: "x" }));
    expect((await setLayerRoleHandler(ctx, { ...role(3), builds_on: many })).isError).toBe(true);
    expect(
      (await setLayerRoleHandler(ctx, { ...role(3), chapter: "a much too long chapter name" }))
        .isError,
    ).toBe(true);
    expect(db.select().from(stackBriefLayers).all()).toHaveLength(0);
  });

  it("counts a role written before chapters as missing", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    await setLayerRoleHandler(ctx, role(2));
    db.update(stackBriefLayers).set({ chapter: null }).run();
    await setLayerRoleHandler(ctx, role(3));
    expect(brief(db).lastCompletedPhase).toBe("none");
  });
});

describe("complete_stack_brief", () => {
  it("refuses until the arc is written, and never writes status", async () => {
    const db = seed();
    const completed = { count: 0 };
    const ctx = ctxFor(db, completed);
    expect((await completeStackBriefHandler(ctx, {})).isError).toBe(true);
    await setLayerRoleHandler(ctx, role(2));
    await setLayerRoleHandler(ctx, role(3));
    const early = await completeStackBriefHandler(ctx, {});
    expect(early.isError).toBe(true);
    expect(text(early)).toContain("set_arc");
    expect(completed.count).toBe(0);

    await setArcHandler(ctx, { arc_markdown: "The arc.", review_order: [121, 122] });
    expect((await completeStackBriefHandler(ctx, {})).isError).toBeUndefined();
    expect(completed.count).toBe(1);
    expect(brief(db).status).toBe("generating");
  });
});

describe("get_stack_brief_state", () => {
  it("returns the snapshot and what a prior run wrote", async () => {
    const db = seed();
    const ctx = ctxFor(db);
    await setLayerRoleHandler(ctx, role(2));
    const state = JSON.parse(text(await getStackBriefStateHandler(ctx, {})));
    expect(state.phase).toBe("none");
    expect(state.snapshot.layers.map((l: { number: number }) => l.number)).toEqual([121, 122]);
    expect(state.layersWritten).toHaveLength(1);
    expect(state.instructions).toContain("prior run");
  });
});

describe("get_stack_layers", () => {
  it("joins each tracked layer's files and latest walkthrough, bounded", async () => {
    const db = seed();
    const now = new Date().toISOString();
    for (let i = 0; i < 85; i++) {
      db.insert(prDiffFiles)
        .values({
          id: `repo-1:121\0f${i}`,
          prId: "repo-1:121",
          path: `src/f${String(i).padStart(2, "0")}.ts`,
          status: "modified",
          fetchedAt: now,
        })
        .run();
    }
    db.insert(walkthroughs)
      .values({
        id: "wt-1",
        reviewSessionId: "s",
        pullRequestId: "repo-1:121",
        summary: "**Adds the brief table.**\n\nContext: more.",
        sentiment: "Solid.",
        riskLevel: "medium",
        status: "complete",
        lastCompletedPhase: "D",
        generatedAt: now,
        completedAt: now,
        modelUsed: "m",
        prHeadSha: "aaa",
      })
      .run();
    for (let i = 0; i < 8; i++) {
      db.insert(walkthroughIssues)
        .values({
          id: `i${i}`,
          walkthroughId: "wt-1",
          order: i,
          severity: "warning",
          title: `Issue ${i}`,
          description: "d",
          createdAt: now,
        })
        .run();
    }

    const out = JSON.parse(text(await getStackLayersHandler(ctxFor(db), {})));
    const [schema, route] = out.layers;
    expect(schema.files).toHaveLength(80);
    expect(schema.filesTruncated).toBe(true);
    expect(schema.walkthrough.current).toBe(true);
    expect(schema.walkthrough.takeaway).toBe("Adds the brief table.");
    expect(schema.walkthrough.openIssues).toBe(8);
    expect(schema.walkthrough.openIssueTitles).toHaveLength(6);
    expect(route.tracked).toBe(false);
    expect(route.files).toEqual([]);
    expect(route.walkthrough).toBeNull();
    expect(route.bodyExcerpt).toBe("Serves it.");
  });
});
