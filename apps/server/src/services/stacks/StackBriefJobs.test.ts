import { describe, expect, it } from "bun:test";
import type { ServerEventMessage } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  type StackBriefSnapshot,
  type StackBriefToolContext,
  setArcHandler,
  setLayerRoleHandler,
} from "../../ai/providers/stack-brief-tools";
import { createDb, type Db } from "../../db/index";
import { stackBriefs } from "../../db/schema/stack-briefs";
import { Broadcaster } from "../Broadcaster";
import { DbService } from "../Db";
import { PrContextService } from "../PrContext";
import { SettingsService } from "../Settings";
import { StackBriefJobs, StackBriefJobsLive } from "./StackBriefJobs";
import { StackService } from "./StackService";

const SNAPSHOT: StackBriefSnapshot = {
  stackNumber: 7,
  baseRefName: "main",
  layers: [
    {
      position: 1,
      number: 121,
      title: "Schema",
      headSha: "aaa",
      status: "ready",
      prId: null,
      additions: 10,
      deletions: 0,
      changedFiles: 2,
      body: null,
    },
  ],
  merged: [],
  capturedAt: "2026-10-16T00:00:00.000Z",
};

function emptyDb(): Db {
  const db = createDb(":memory:");
  (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
    "PRAGMA foreign_keys = OFF",
  );
  return db;
}

function seedBrief(db: Db, id: string, resumeAttempts = 0): StackBriefToolContext {
  db.insert(stackBriefs)
    .values({
      id,
      repositoryId: "repo-1",
      stackNumber: 7,
      signature: `sig-${id}`,
      stackSnapshot: SNAPSHOT,
      status: "generating",
      userId: "u",
      createdAt: new Date().toISOString(),
      resumeAttempts,
    })
    .run();
  return { db, briefId: id, onCompleted: () => {}, onToolCall: () => {} };
}

function resume(db: Db) {
  const events: ServerEventMessage[] = [];
  const deps = Layer.mergeAll(
    Layer.succeed(DbService, { db }),
    Layer.succeed(Broadcaster, {
      register: () => Effect.succeed(() => undefined),
      broadcastToAccount: (_accountId: string, msg: ServerEventMessage) =>
        Effect.sync(() => {
          events.push(msg);
        }),
      broadcastAll: () => Effect.void,
    }),
    Layer.succeed(PrContextService, {
      getAccountIdForRepo: () => Effect.succeed("acct-1"),
    } as never),
    Layer.succeed(SettingsService, {} as never),
    Layer.succeed(StackService, {} as never),
  );
  return Effect.runPromise(
    Effect.flatMap(StackBriefJobs, (jobs) => jobs.resumePending()).pipe(
      Effect.provide(StackBriefJobsLive.pipe(Layer.provide(deps))),
    ),
  ).then(() => events);
}

function brief(db: Db, id: string) {
  const row = db.select().from(stackBriefs).where(eq(stackBriefs.id, id)).get();
  if (!row) throw new Error("brief missing");
  return row;
}

describe("StackBriefJobs.resumePending", () => {
  it("completes a brief whose journal already passes, without spending a resume", async () => {
    const db = emptyDb();
    const ctx = seedBrief(db, "written");
    await setLayerRoleHandler(ctx, {
      position: 1,
      role: "Lays the schema.",
      review_focus: "The migration default.",
      chapter: "Storage",
      builds_on: [],
    });
    await setArcHandler(ctx, { arc_markdown: "#121 lays the schema.", review_order: [121] });

    const events = await resume(db);

    expect(brief(db, "written").status).toBe("complete");
    expect(brief(db, "written").resumeAttempts).toBe(0);
    expect(events).toContainEqual({
      type: "stack-brief:status-changed",
      data: { repositoryId: "repo-1", stackNumber: 7, briefId: "written", status: "complete" },
    });
  });

  it("still spends the budget on a brief that needs the agent", async () => {
    const db = emptyDb();
    seedBrief(db, "unwritten", 3);

    await resume(db);

    expect(brief(db, "unwritten").status).toBe("error");
    expect(brief(db, "unwritten").resumeAttempts).toBe(4);
  });
});
