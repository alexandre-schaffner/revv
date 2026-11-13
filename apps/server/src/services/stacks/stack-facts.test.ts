import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createDb, type Db } from "../../db/index";
import { prDiffFiles, pullRequests, walkthroughs } from "../../db/schema";
import type { GitHubStack } from "../github/stacks";
import { fingerprintFiles } from "../walkthrough/restack";
import { readStackFacts } from "./StackService";

// The overlay's `restacked` label and the launch decide on one rule: a layer
// is labelled a carry only when queueing its review would carry one over.

const NOW = "2026-10-16T00:00:00Z";
const FILE = { filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n+a" };
const STACK = { number: 7, layers: [{ number: 12 }] } as unknown as GitHubStack;

function seed(
  sourceGenerationMode: "full" | "incremental",
  mode: "author" | "reviewer" = "reviewer",
): Db {
  const db = createDb(":memory:");
  db.$client.run("PRAGMA foreign_keys = OFF");
  db.insert(pullRequests)
    .values({
      id: "pr-12",
      externalId: 12,
      repositoryId: "repo-1",
      title: "Layer",
      authorLogin: "a",
      sourceBranch: "feat",
      targetBranch: "main",
      url: "",
      headSha: "head-2",
      baseSha: "base",
      diffFilesHeadSha: "head-2",
      diffFilesBaseSha: "base",
      createdAt: NOW,
      updatedAt: NOW,
      fetchedAt: NOW,
    })
    .run();
  db.insert(prDiffFiles)
    .values({
      id: `pr-12\0${FILE.filename}`,
      prId: "pr-12",
      path: FILE.filename,
      status: FILE.status,
      patch: FILE.patch,
      fetchedAt: NOW,
    })
    .run();
  db.insert(walkthroughs)
    .values({
      id: "wt-old",
      reviewSessionId: "session-1",
      pullRequestId: "pr-12",
      generatedAt: NOW,
      modelUsed: "m",
      tokenUsage: "{}",
      prHeadSha: "head-1",
      status: "superseded",
      lastCompletedPhase: "D",
      completedAt: NOW,
      generationMode: sourceGenerationMode,
      diffFingerprint: fingerprintFiles([FILE]),
      mode,
    })
    .run();
  return db;
}

const layerOf = async (db: Db) =>
  (await Effect.runPromise(readStackFacts(db, "repo-1", STACK))).tracked.get(12);
const carriesFor = async (db: Db) => (await layerOf(db))?.carries;

describe("readStackFacts", () => {
  it("labels a pure restack of a full review a carry", async () => {
    expect(await carriesFor(seed("full"))).toBe(true);
  });

  it("doesn't when the queued full review wouldn't take an incremental one over", async () => {
    expect(await carriesFor(seed("incremental"))).toBe(false);
  });

  // "Review the stack" queues each layer in its own perspective: on the user's
  // own PR, an author review is the one it reads and carries over.
  it("reads and carries a layer's review in the layer's own perspective", async () => {
    const layer = await layerOf(seed("full", "author"));
    expect(layer?.latestFinished?.id).toBe("wt-old");
    expect(layer?.carries).toBe(true);
  });

  it("ignores a review in the perspective the user has since left", async () => {
    const db = seed("full", "author");
    db.insert(walkthroughs)
      .values({
        id: "wt-switch",
        reviewSessionId: "session-1",
        pullRequestId: "pr-12",
        generatedAt: "2026-10-17T00:00:00Z",
        modelUsed: "m",
        tokenUsage: "{}",
        prHeadSha: "head-2",
        status: "error",
        mode: "reviewer",
      })
      .run();
    const layer = await layerOf(db);
    expect(layer?.latestFinished).toBeNull();
    expect(layer?.current).toEqual({ id: "wt-switch", status: "error" });
  });
});
