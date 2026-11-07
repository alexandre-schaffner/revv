import { describe, expect, it } from "bun:test";
import type { ServerEventMessage } from "@revv/shared";
import { Effect, Layer } from "effect";
import { type JobStartAnswers, jobStartCacheKey } from "../../ai/jev/job-start";
import { buildJobStartState } from "../../ai/jev/state";
import { createDb } from "../../db";
import { pullRequests } from "../../db/schema";
import { DbService } from "../Db";
import { DiffCacheService, DiffCacheServiceLive } from "../DiffCache";
import { GitHubGateway } from "../github/gateway";
import type { PrCommit, PrFileMeta } from "../github/pulls";
import { githubClient } from "../github/transport";
import { Realtime } from "../Realtime";
import { buildJobStartPlan, launchDiff } from "./launch-plan";

const settings = { aiModel: "revv:auto", aiThinkingEffort: "revv:auto" } as const;

const answers: JobStartAnswers = {
  riskLevel: "high",
  riskConfidence: 0.9,
  depth: "deep",
  depthConfidence: 0.9,
  depthProbabilities: { deep: 0.9 },
  reasoningEffort: "thorough",
  filePriorities: { "a.ts": 4 },
  splitScore: 0,
};

describe("job-start plan", () => {
  it("projects one answer into risk, routing and file priority", () => {
    const plan = buildJobStartPlan({
      settings,
      agent: "claude-code",
      files: [{ filename: "a.ts" }],
      answers,
    });
    expect(plan.assignedRisk).toBe("high");
    expect(plan.filePriorities).toEqual([{ filename: "a.ts", tier: 4 }]);
    expect(plan.launchOverride?.thinkingEffort).toBe("high");
  });
});

describe("the job-start state of a PR's head", () => {
  const PR = {
    id: "pr-1",
    externalId: 1,
    repositoryId: "repo-1",
    title: "Widget",
    body: null,
    authorLogin: "alex",
    sourceBranch: "feat",
    targetBranch: "main",
    url: "https://github.com/o/r/pull/1",
    headSha: "head",
    baseSha: "base",
    additions: 3,
    deletions: 1,
    changedFiles: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
  const FILES: PrFileMeta[] = [
    {
      filename: "b.ts",
      previousFilename: null,
      status: "added",
      additions: 2,
      deletions: 0,
      patch: "@@ b",
    },
    {
      filename: "a.ts",
      previousFilename: null,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ a",
    },
  ];
  const COMMITS: PrCommit[] = [
    {
      sha: "head",
      message: "feat: widget",
      authorLogin: "alex",
      authorAvatarUrl: null,
      date: null,
    },
    { sha: "c1", message: "refactor: split", authorLogin: null, authorAvatarUrl: null, date: null },
  ];

  // The launch fetches the diff (GitHub, written through); the review page's
  // preview reads only what that stored. Before both read stored commits, the
  // preview asked with none and the launch with real ones, and whichever asked
  // first decided the cached judgment for both.
  it("is the same for the preview and the launch, commit subjects included", async () => {
    const db = createDb(":memory:");
    db.$client.run("PRAGMA foreign_keys = OFF");
    db.insert(pullRequests).values(PR).run();
    const layer = DiffCacheServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DbService, { db }),
          Layer.succeed(GitHubGateway, {
            prs: { files: () => Effect.succeed(FILES), commits: () => Effect.succeed(COMMITS) },
          } as never),
          Layer.succeed(Realtime, {
            toPr: (_prId: string, _msg: ServerEventMessage) => Effect.void,
          } as never),
        ),
      ),
    );
    const { launched, previewed } = await Effect.runPromise(
      Effect.gen(function* () {
        const diffCache = yield* DiffCacheService;
        const launched = yield* diffCache.getOrFetch(
          PR,
          "o/r",
          githubClient("github.com", "t", "a"),
        );
        const previewed = yield* diffCache.getCachedDiff(PR.id);
        return { launched, previewed };
      }).pipe(Effect.provide(layer)),
    );
    expect(launched.source).toBe("github");
    if (previewed === null) throw new Error("the launch's diff was not stored");

    const atLaunch = { pr: PR, ...launchDiff(launched) };
    const inPreview = { pr: PR, ...launchDiff(previewed) };
    expect(jobStartCacheKey(PR.id, PR.headSha, inPreview)).toBe(
      jobStartCacheKey(PR.id, PR.headSha, atLaunch),
    );
    expect(buildJobStartState(inPreview)).toEqual(buildJobStartState(atLaunch));
    expect(buildJobStartState(inPreview)).toMatchObject({
      commits: ["feat: widget", "refactor: split"],
      commit_count: 2,
    });
  });
});
