import { describe, expect, it } from "bun:test";
import type { ServerEventMessage } from "@revv/shared";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../../db/index";
import { walkthroughs } from "../../db/schema";
import { AiService } from "../Ai";
import { CacheService } from "../Cache";
import { RepoCloneService } from "../clone/RepoClone";
import { DbService } from "../Db";
import { DiffCacheService } from "../DiffCache";
import { HunkScanService } from "../hunk-scan/HunkScan";
import { JevService } from "../Jev";
import { PrContextService } from "../PrContext";
import { Realtime } from "../Realtime";
import { ReviewService } from "../Review";
import { SettingsService } from "../Settings";
import { StackService } from "../stacks/StackService";
import { RemoteWalkthroughCache } from "./RemoteWalkthroughCache";
import { WalkthroughServiceLive } from "./Walkthrough";
import { WalkthroughJobs, WalkthroughJobsLive } from "./WalkthroughJobs";
import { WalkthroughSnapshotImporter } from "./WalkthroughSnapshotImporter";

const NOW = "2026-11-01T00:00:00Z";
const PR = {
  id: "pr-1",
  externalId: 42,
  title: "Fix the widget",
  body: null,
  sourceBranch: "feature",
  targetBranch: "main",
  url: "https://github.com/acme/widget/pull/42",
};
const REPO = { id: "repo-1", fullName: "acme/widget", githubHost: "github.com" };

function seed(db: Db, row: { id: string; status: "generating" | "error"; head: string }): void {
  db.$client.run("PRAGMA foreign_keys = OFF");
  db.insert(walkthroughs)
    .values({
      id: row.id,
      reviewSessionId: "session-1",
      pullRequestId: PR.id,
      generatedAt: NOW,
      modelUsed: "m",
      tokenUsage: "{}",
      prHeadSha: row.head,
      status: row.status,
      lastCompletedPhase: "B",
    })
    .run();
}

/** The orchestrator over a real journal, with GitHub reporting the PR at `head`. */
function jobsAt(db: Db, head: string) {
  const sent: ServerEventMessage[] = [];
  const context = { pr: { ...PR, headSha: head }, repo: REPO, accountId: "account-1", client: {} };
  const unused = {} as never;
  const layer = WalkthroughJobsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DbService, { db }),
        WalkthroughServiceLive,
        Layer.succeed(PrContextService, {
          forPr: () => Effect.succeed(context),
          withDiff: () =>
            Effect.succeed({
              ...context,
              meta: { headSha: head, baseSha: "base" },
              files: [],
              commits: [],
            }),
        } as never),
        Layer.succeed(RepoCloneService, {
          getCloneStatus: () => Effect.succeed({ status: "ready", path: "/tmp/x", error: null }),
        } as never),
        Layer.succeed(Realtime, {
          toAccount: (_accountId: string, msg: ServerEventMessage) =>
            Effect.sync(() => sent.push(msg)),
          toPr: (_prId: string, msg: ServerEventMessage) => Effect.sync(() => sent.push(msg)),
        } as never),
        Layer.succeed(AiService, unused),
        Layer.succeed(ReviewService, unused),
        Layer.succeed(SettingsService, unused),
        Layer.succeed(RemoteWalkthroughCache, unused),
        Layer.succeed(JevService, unused),
        Layer.succeed(HunkScanService, unused),
        Layer.succeed(CacheService, unused),
        Layer.succeed(DiffCacheService, unused),
        Layer.succeed(WalkthroughSnapshotImporter, unused),
        Layer.succeed(StackService, unused),
      ),
    ),
  );
  const run = <A, E>(f: (jobs: WalkthroughJobs["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(WalkthroughJobs, f).pipe(Effect.provide(layer)));
  return { run, sent };
}

const rowsOf = (db: Db) =>
  db.select({ id: walkthroughs.id, status: walkthroughs.status }).from(walkthroughs).all();

describe("resuming a walkthrough", () => {
  // The resumed row keeps its id; the new head gets a new row only when
  // someone asks for one, so nothing collides with the old row's key.
  it("supersedes a row whose PR moved past its head instead of running it", async () => {
    const db = createDb(":memory:");
    seed(db, { id: "wt-1", status: "generating", head: "head-1" });
    const { run, sent } = jobsAt(db, "head-2");

    expect(await run((jobs) => jobs.resume("wt-1"))).toBe("superseded");
    expect(rowsOf(db)).toEqual([{ id: "wt-1", status: "superseded" }]);
    expect(sent.map((m) => m.type)).toEqual(["walkthrough:event"]);
  });

  it("leaves a stopped row whose head moved superseded, not revived", async () => {
    const db = createDb(":memory:");
    seed(db, { id: "wt-1", status: "error", head: "head-1" });
    const { run } = jobsAt(db, "head-2");

    expect(await run((jobs) => jobs.resume("wt-1"))).toBe("superseded");
    expect(rowsOf(db)).toEqual([{ id: "wt-1", status: "superseded" }]);
  });
});

describe("an automatic request", () => {
  it("leaves a failed review at the head standing", async () => {
    const db = createDb(":memory:");
    seed(db, { id: "wt-err", status: "error", head: "head-1" });
    const { run } = jobsAt(db, "head-1");

    const result = await run((jobs) =>
      jobs.startJob({ prId: PR.id, trigger: "review_requested", replace: "none" }),
    );

    expect(result).toEqual({ walkthroughId: "wt-err", reused: true });
    expect(rowsOf(db)).toEqual([{ id: "wt-err", status: "error" }]);
  });
});
