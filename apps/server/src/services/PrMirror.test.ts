import { describe, expect, it } from "bun:test";
import type { PullRequest } from "@revv/shared";
import type { Context } from "effect";
import { Effect } from "effect";
import { asStored, type ObservedPr, STACK_UNSEEN, stackSeen } from "../domain/observed-pr";
import type { GitHubGateway } from "./github/gateway";
import { githubClient } from "./github/transport";
import { ACCOUNT_ID, type Harness, makeHarness, REPO, seedDb } from "./poll-test-support";

const T1 = "2026-01-01T00:00:00Z";
const T2 = "2026-01-02T00:00:00Z";
const client = githubClient("github.com", "token", ACCOUNT_ID);

function observed(overrides: Partial<ObservedPr> = {}): ObservedPr {
  return {
    id: "repo-1:1",
    externalId: 1,
    repositoryId: REPO.id,
    title: "PR 1",
    body: null,
    authorLogin: "author",
    authorAvatarContent: null,
    authorAvatarUrl: null,
    requestedReviewers: [],
    mentionedUsers: [],
    status: "open",
    reviewStatus: "pending",
    isDraft: false,
    sourceBranch: "feature",
    targetBranch: "main",
    url: "https://github.test/pull/1",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headSha: "head-1",
    baseSha: "base",
    createdAt: T1,
    updatedAt: T1,
    fetchedAt: T1,
    closedAt: null,
    stack: STACK_UNSEEN,
    ...overrides,
  };
}

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);

async function stored(h: Harness, row: ObservedPr): Promise<PullRequest> {
  await run(h.prService.upsertPrs([row]));
  return asStored(row, undefined);
}

const readRow = (h: Harness, id = "repo-1:1") => run(h.prService.getPr(id));

/** Let the detached worktree prune run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("PrMirror.apply", () => {
  it("doesn't let a stale read rewind the head", async () => {
    const h = await makeHarness(seedDb());
    await stored(h, observed({ headSha: "new", updatedAt: T2 }));

    await run(h.mirror.apply([observed({ headSha: "old", updatedAt: T1 })]));

    expect((await readRow(h)).headSha).toBe("new");
    expect(h.recorded.superseded).toEqual([]);
  });

  it("supersedes walkthroughs pinned to the old head on a trusted head move", async () => {
    const h = await makeHarness(seedDb());
    await stored(h, observed({ headSha: "h1", updatedAt: T1 }));

    await run(h.mirror.apply([observed({ headSha: "h2", updatedAt: T2 })]));

    expect((await readRow(h)).headSha).toBe("h2");
    expect(h.recorded.superseded).toEqual([{ prId: "repo-1:1", exceptHeadSha: "h2" }]);
    expect(h.recorded.events.some((e) => e.to === ACCOUNT_ID && e.msg.type === "prs:updated")).toBe(
      true,
    );
  });

  it("archives a PR that went terminal once, and leaves a closed one alone", async () => {
    const h = await makeHarness(seedDb());
    await stored(h, observed());

    await run(h.mirror.apply([observed({ status: "merged", closedAt: T2, updatedAt: T2 })]));
    await settle();
    await run(h.mirror.apply([observed({ status: "merged", closedAt: T2, updatedAt: T2 })]));
    await settle();

    const archived = h.recorded.events.filter((e) => e.msg.type === "pr:archived");
    expect(archived).toHaveLength(1);
    expect(archived[0]).toEqual({
      to: ACCOUNT_ID,
      msg: {
        type: "pr:archived",
        data: { prId: "repo-1:1", repoId: REPO.id, status: "merged", closedAt: T2 },
      },
    });
    expect(h.recorded.pruned).toEqual([{ repoId: REPO.id, prNumber: 1 }]);
  });

  it("writes the diff size with the head it describes", async () => {
    const h = await makeHarness(seedDb());

    await run(
      h.mirror.apply([
        observed({ additions: 3, deletions: 2, changedFiles: 4, statsHeadSha: "head-1" }),
      ]),
    );

    const row = await readRow(h);
    expect([row.additions, row.deletions, row.changedFiles]).toEqual([3, 2, 4]);
    const heads = await run(h.prService.diffStatsHeads());
    expect(heads.get("repo-1:1")).toBe("head-1");
  });
});

describe("PrMirror.recordPushes", () => {
  const gatewayAnswering = (answer: ObservedPr) =>
    ({
      prs: { get: () => Effect.succeed(answer) },
    }) as unknown as Partial<Context.Service.Shape<typeof GitHubGateway>>;

  it("takes GitHub's detail when it already shows the pushed tip", async () => {
    const db = seedDb();
    const h = await makeHarness(db, gatewayAnswering(observed({ headSha: "tip", updatedAt: T2 })));
    const pr = await stored(h, observed({ headSha: "h1", updatedAt: T1 }));

    await run(
      h.mirror.recordPushes({ repo: REPO, client }, [{ prNumber: pr.externalId, newTip: "tip" }]),
    );

    const row = await readRow(h);
    expect([row.headSha, row.updatedAt]).toEqual(["tip", T2]);
    expect(h.recorded.superseded).toEqual([{ prId: pr.id, exceptHeadSha: "tip" }]);
  });

  it("stamps the tip with the push time while GitHub still shows the old head", async () => {
    const db = seedDb();
    const h = await makeHarness(db, gatewayAnswering(observed({ headSha: "h1", updatedAt: T1 })));
    const pr = await stored(h, observed({ headSha: "h1", updatedAt: T1 }));
    const before = Date.now();

    await run(
      h.mirror.recordPushes({ repo: REPO, client }, [{ prNumber: pr.externalId, newTip: "tip" }]),
    );

    const row = await readRow(h);
    expect(row.headSha).toBe("tip");
    expect(Date.parse(row.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(h.recorded.superseded).toEqual([{ prId: pr.id, exceptHeadSha: "tip" }]);
  });
});

describe("PrMirror.recordMutation", () => {
  it("records a retarget and marks the PR's stack stale", async () => {
    const h = await makeHarness(seedDb());
    const pr = await stored(
      h,
      observed({ targetBranch: "layer-1", stack: stackSeen({ number: 7, position: 2 }) }),
    );

    await run(h.mirror.recordMutation(pr.id, { kind: "base", targetBranch: "main" }));

    expect((await readRow(h)).targetBranch).toBe("main");
    expect(h.recorded.staleStacks).toEqual([`${REPO.id}:7`]);
  });
});
