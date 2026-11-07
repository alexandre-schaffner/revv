import { describe, expect, it } from "bun:test";
import type { ServerEventMessage } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../../db/index";
import { walkthroughs } from "../../db/schema";
import { AiService } from "../Ai";
import { CacheService } from "../Cache";
import { RepoCloneService } from "../clone/RepoClone";
import { DbService } from "../Db";
import { DiffCacheService } from "../DiffCache";
import { GitHubGateway } from "../github/gateway";
import { HunkScanService } from "../hunk-scan/HunkScan";
import { JevService } from "../Jev";
import { PrContextService } from "../PrContext";
import { PrMirror } from "../PrMirror";
import { PrHeadMoves, PrHeadMovesLive } from "../pr-head-moves";
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

function seed(
  db: Db,
  row: { id: string; status: "generating" | "error"; head: string; resumeAttempts?: number },
): void {
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
      resumeAttempts: row.resumeAttempts ?? 0,
    })
    .run();
}

/**
 * The orchestrator over a real journal, with GitHub reporting the PR at `head`
 * and the mirror holding it at `stored` (by default the same head). Like the
 * real mirror, the fake records the head it is handed and publishes a head
 * move on `PrHeadMoves` when it moved. `trace` records the mirror writes and
 * diff-cache reads, in order.
 */
function jobsAt(db: Db, head: string, options: { readonly stored?: string } = {}) {
  const sent: ServerEventMessage[] = [];
  const trace: string[] = [];
  const stored = options.stored ?? head;
  const context = {
    pr: { ...PR, headSha: stored },
    repo: REPO,
    accountId: "account-1",
    client: {},
  };
  const unused = {} as never;
  const realtime = Layer.succeed(Realtime, {
    toAccount: (_accountId: string, msg: ServerEventMessage) => Effect.sync(() => sent.push(msg)),
    toPr: (_prId: string, msg: ServerEventMessage) => Effect.sync(() => sent.push(msg)),
  } as never);
  const layer = WalkthroughJobsLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(DbService, { db }),
        WalkthroughServiceLive.pipe(
          Layer.provide(Layer.merge(Layer.succeed(DbService, { db }), realtime)),
        ),
        Layer.succeed(PrContextService, {
          readPr: () => Effect.succeed({ pr: context.pr, repo: REPO, accountId: "account-1" }),
          forPr: () => Effect.succeed(context),
        } as never),
        Layer.succeed(GitHubGateway, {
          prs: {
            get: () => Effect.succeed({ ...PR, headSha: head, baseSha: "base" }),
            commits: () => Effect.succeed([]),
          },
        } as never),
        Layer.effect(
          PrMirror,
          Effect.map(
            Effect.service(PrHeadMoves),
            (headMoves) =>
              ({
                apply: (rows: ReadonlyArray<{ id: string; headSha: string }>) =>
                  Effect.gen(function* () {
                    trace.push(`mirror ${rows[0]?.headSha}`);
                    const live = rows[0];
                    if (live && live.headSha !== context.pr.headSha) {
                      context.pr = { ...context.pr, headSha: live.headSha };
                      yield* headMoves.publish(live.id, live.headSha);
                    }
                    return { rows, accountIds: new Set() };
                  }),
              }) as never,
          ),
        ).pipe(Layer.provideMerge(PrHeadMovesLive)),
        Layer.succeed(DiffCacheService, {
          getOrFetch: (pr: { headSha: string }) =>
            Effect.sync(() => {
              trace.push(`diff ${pr.headSha}`);
              return { files: [] };
            }),
        } as never),
        Layer.succeed(RepoCloneService, {
          getCloneStatus: () => Effect.succeed({ status: "ready", path: "/tmp/x", error: null }),
        } as never),
        realtime,
        Layer.succeed(AiService, unused),
        Layer.succeed(ReviewService, unused),
        Layer.succeed(SettingsService, unused),
        Layer.succeed(RemoteWalkthroughCache, unused),
        Layer.succeed(JevService, unused),
        Layer.succeed(HunkScanService, unused),
        Layer.succeed(CacheService, unused),
        Layer.succeed(WalkthroughSnapshotImporter, unused),
        Layer.succeed(StackService, unused),
      ),
    ),
  );
  const run = <A, E>(
    f: (jobs: WalkthroughJobs["Service"], headMoves: PrHeadMoves["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* f(yield* WalkthroughJobs, yield* PrHeadMoves);
      }).pipe(Effect.provide(layer)),
    );
  return { run, sent, trace };
}

/** Waits for row `id` to reach `status`: a head-move supersede runs on its own fiber. */
const untilStatus = (db: Db, id: string, status: string) =>
  Effect.gen(function* () {
    const statusOf = () =>
      db
        .select({ status: walkthroughs.status })
        .from(walkthroughs)
        .where(eq(walkthroughs.id, id))
        .get()?.status;
    while (statusOf() !== status) yield* Effect.sleep(1);
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.die(new Error(`${id} never became ${status}`)),
    }),
  );

const rowsOf = (db: Db) =>
  db.select({ id: walkthroughs.id, status: walkthroughs.status }).from(walkthroughs).all();

const endOf = (db: Db) =>
  db
    .select({ status: walkthroughs.status, endReason: walkthroughs.endReason })
    .from(walkthroughs)
    .all();

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

describe("a request", () => {
  it("records a head the poll hasn't seen through the mirror before it reads the diff", async () => {
    const db = createDb(":memory:");
    seed(db, { id: "wt-err", status: "error", head: "head-2" });
    const { run, trace } = jobsAt(db, "head-2");

    await run((jobs) =>
      jobs.startJob({ prId: PR.id, trigger: "review_requested", replace: "none" }),
    );

    expect(trace).toEqual(["mirror head-2", "diff head-2"]);
  });
});

describe("a request that finds the PR moved past a running review", () => {
  // The request writes the live head through the mirror while it holds the PR
  // lock; the head-move listener supersedes under that lock too. The listener
  // runs on its own fiber, so it waits for the request instead of the two
  // waiting on each other forever.
  it("supersedes the old head's row through the head-move listener, and completes", async () => {
    const db = createDb(":memory:");
    seed(db, { id: "wt-old", status: "generating", head: "head-1" });
    seed(db, { id: "wt-err", status: "error", head: "head-2" });
    const { run, trace } = jobsAt(db, "head-2", { stored: "head-1" });

    const result = await run((jobs) =>
      jobs.startJob({ prId: PR.id, trigger: "review_requested", replace: "none" }).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.die(new Error("startJob deadlocked on the PR lock")),
        }),
        Effect.tap(() => untilStatus(db, "wt-old", "superseded")),
      ),
    );

    expect(result).toEqual({ walkthroughId: "wt-err", reused: true });
    expect(trace).toEqual(["mirror head-2", "diff head-2"]);
    expect(endOf(db)).toEqual([
      { status: "superseded", endReason: "superseded" },
      { status: "error", endReason: null },
    ]);
  });
});

describe("a head move heard late", () => {
  // Listeners run off the publisher, so a move's supersede can land after the
  // PR moved again and a request created the newer head's row.
  it("spares the head the PR holds now, not the one published", async () => {
    const db = createDb(":memory:");
    seed(db, { id: "wt-1", status: "generating", head: "head-1" });
    seed(db, { id: "wt-3", status: "error", head: "head-3" });
    const { run } = jobsAt(db, "head-3");

    await run((_jobs, headMoves) =>
      headMoves
        .publish(PR.id, "head-2")
        .pipe(Effect.tap(() => untilStatus(db, "wt-1", "superseded"))),
    );

    expect(rowsOf(db)).toEqual([
      { id: "wt-1", status: "superseded" },
      { id: "wt-3", status: "error" },
    ]);
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

describe("a request that finds a dead run at the head", () => {
  // The resume budget holds whoever finds the row: a request doesn't relaunch
  // a row that has already crashed its way through it.
  it("fails it over the resume budget instead of running it again", async () => {
    const db = createDb(":memory:");
    seed(db, { id: "wt-dead", status: "generating", head: "head-1", resumeAttempts: 3 });
    const { run } = jobsAt(db, "head-1");

    const result = await run((jobs) =>
      jobs.startJob({ prId: PR.id, trigger: "review_requested", replace: "none" }),
    );

    expect(result).toEqual({ walkthroughId: "wt-dead", reused: true });
    expect(endOf(db)).toEqual([{ status: "error", endReason: "resume_budget" }]);
  });
});
