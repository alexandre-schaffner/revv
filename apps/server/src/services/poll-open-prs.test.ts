import { describe, expect, it } from "bun:test";
import type { PullRequest } from "@revv/shared";
import type { Context } from "effect";
import { Effect } from "effect";
import { GitHubRateLimitError } from "../domain/errors";
import { type ObservedPr, STACK_UNSEEN, stackSeen } from "../domain/observed-pr";
import type { GitHubGateway } from "./github/gateway";
import type { OpenPrList, OpenPrListSignature } from "./github/pulls";
import type { GitHubClient } from "./github/transport";
import { openGate } from "./poll-gate";
import {
  movedRangePrIds,
  openListMoved,
  probeRepos,
  type RepoListingContext,
  settleVanishedPrs,
  syncRepoOpenPrs,
} from "./poll-open-prs";
import { type ListedSignature, makePollState, type PollState } from "./poll-state";
import { ACCOUNT_ID, makeHarness, REPO, seedDb } from "./poll-test-support";

function pr(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `repo-1:${number}`,
    externalId: number,
    repositoryId: "repo-1",
    title: `PR ${number}`,
    body: null,
    authorLogin: "author",
    authorAvatarContent: null,
    requestedReviewers: [],
    mentionedUsers: [],
    status: "open",
    isDraft: false,
    sourceBranch: "feature",
    targetBranch: "main",
    url: `https://github.test/pull/${number}`,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headSha: `head-${number}`,
    baseSha: "base",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    stack: null,
    ...overrides,
  };
}

const graphqlLimit = () =>
  new GitHubRateLimitError({
    resetAt: new Date(Date.now() + 60 * 60 * 1000),
    kind: "primary",
    resource: "graphql",
  });

interface Fakes {
  listOpen: (updatedSince: string | null) => Effect.Effect<PullRequest[], GitHubRateLimitError>;
  listClosedSince: () => Effect.Effect<number[] | null>;
  listOpenRest: () => Effect.Effect<PullRequest[]>;
  probe: () => Effect.Effect<Map<string, OpenPrListSignature>>;
  getMany: (
    numbers: readonly number[],
  ) => Effect.Effect<Map<number, ObservedPr>, GitHubRateLimitError>;
  stacks?: "listed" | "refused" | "unsupported";
}

const unseenStack = (pr: PullRequest): ObservedPr => ({
  ...pr,
  authorAvatarUrl: null,
  stack: STACK_UNSEEN,
});
const seenStack = (pr: PullRequest): ObservedPr => ({
  ...pr,
  authorAvatarUrl: null,
  stack: stackSeen(pr.stack),
});

async function setup(overrides: Partial<Fakes> = {}) {
  const db = seedDb();
  const harness = await makeHarness(db);
  const fakes: Fakes = {
    listOpen: () => Effect.succeed([]),
    listOpenRest: () => Effect.succeed([]),
    listClosedSince: () => Effect.succeed([]),
    probe: () => Effect.succeed(new Map()),
    getMany: () => Effect.succeed(new Map()),
    ...overrides,
  };
  const log: string[] = [];
  const upserts: Array<{ rows: readonly ObservedPr[] }> = [];
  // The transport reports each rate limit to GitHubAccounts as it happens.
  const observed = <A, E>(client: GitHubClient, eff: Effect.Effect<A, E>) =>
    eff.pipe(
      Effect.tapError((err) =>
        err instanceof GitHubRateLimitError
          ? harness.accounts.observer.rateLimited(client, err)
          : Effect.void,
      ),
    );
  const github = {
    prs: {
      listOpen: (
        client: GitHubClient,
        _repo: string,
        _repoId: string,
        {
          withStacks = true,
          updatedSince = null,
        }: { withStacks?: boolean; updatedSince?: string | null } = {},
      ) => {
        log.push(
          (withStacks ? "list:graphql" : "list:graphql:no-stacks") +
            (updatedSince ? `:since=${updatedSince}` : ""),
        );
        return observed(
          client,
          fakes.listOpen(updatedSince).pipe(
            Effect.map((prs): OpenPrList => {
              const stacks = withStacks ? (fakes.stacks ?? "listed") : "refused";
              return {
                prs: prs.map(stacks === "listed" ? seenStack : unseenStack),
                hostPredatesStacks: stacks === "unsupported",
              };
            }),
          ),
        );
      },
      listOpenRest: () => {
        log.push("list:rest");
        return fakes.listOpenRest().pipe(Effect.map((prs) => prs.map(unseenStack)));
      },
      listClosedSince: () => {
        log.push("closed-since");
        return fakes.listClosedSince();
      },
      probeOpenLists: () => {
        log.push("probe");
        return fakes.probe();
      },
      diffStats: (_client: GitHubClient, _repo: string, numbers: readonly number[]) => {
        log.push("diffStats");
        return Effect.succeed(
          new Map(numbers.map((n) => [n, { additions: 1, deletions: 1, changedFiles: 1 }])),
        );
      },
      getMany: (
        client: GitHubClient,
        _repo: string,
        _repoId: string,
        numbers: readonly number[],
      ) => {
        log.push(`getMany:${numbers.join(",")}`);
        return observed(client, fakes.getMany(numbers));
      },
    },
  } as unknown as Context.Service.Shape<typeof GitHubGateway>;
  const mirror = {
    ...harness.mirror,
    apply: (rows: readonly ObservedPr[], options?: Parameters<typeof harness.mirror.apply>[1]) => {
      log.push(`upsert:${rows.map((r) => r.headSha).join(",")}`);
      upserts.push({ rows });
      return harness.mirror.apply(rows, options);
    },
  };
  const avatars = {
    ensure: () => Effect.succeed({ id: null, changed: false }),
    contents: () => Effect.succeed(new Map<string, string>()),
  };
  const state = makePollState();
  const gate = (repoIds: readonly string[] = [REPO.id]) =>
    openGate(harness.accounts, new Map(repoIds.map((id) => [id, ACCOUNT_ID])));
  const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);
  return { db, harness, fakes, github, mirror, avatars, state, gate, log, upserts, run };
}

type Env = Awaited<ReturnType<typeof setup>>;

function context(existing: PullRequest[], overrides: Partial<RepoListingContext> = {}) {
  return {
    existingMap: new Map(existing.map((p) => [p.id, p])),
    existingByRepo: Map.groupBy(existing, (p) => p.repositoryId),
    diffStatsHeadByPrId: new Map<string, string | null>(),
    unchangedRepoIds: new Set<string>(),
    probedSignatures: new Map<string, OpenPrListSignature>(),
    ...overrides,
  } satisfies RepoListingContext;
}

const syncRepo = (env: Env, ctx: RepoListingContext, state: PollState = env.state) =>
  env.run(
    Effect.gen(function* () {
      const gate = yield* env.gate();
      return yield* syncRepoOpenPrs(
        { github: env.github, mirror: env.mirror, avatars: env.avatars },
        gate,
        state,
        ctx,
        REPO,
      );
    }),
  );

describe("syncRepoOpenPrs", () => {
  it("falls back to the REST list when the GraphQL budget runs out", async () => {
    const env = await setup({
      listOpen: () => Effect.fail(graphqlLimit()),
      listOpenRest: () => Effect.succeed([pr(1)]),
    });

    const result = await syncRepo(env, context([]));

    expect(result?.prs.map((p) => p.id)).toEqual(["repo-1:1"]);
    // No diff stats: they are GraphQL too.
    expect(env.log).toEqual(["list:graphql", "list:rest", "upsert:head-1"]);
    expect(await env.run(env.harness.accounts.backgroundClient(ACCOUNT_ID, "graphql"))).toBeNull();
    expect(await env.run(env.harness.accounts.backgroundClient(ACCOUNT_ID, "core"))).not.toBeNull();
  });

  it("goes straight to REST while GraphQL is paused, and still pauses everything on a secondary limit", async () => {
    const env = await setup({ listOpen: () => Effect.fail(graphqlLimit()) });

    await syncRepo(env, context([]));
    // The pause outlives the cycle that hit it.
    await syncRepo(env, context([]));
    expect(env.log.filter((l) => l.startsWith("list:"))).toEqual([
      "list:graphql",
      "list:rest",
      "list:rest",
    ]);

    const client = await env.run(env.harness.accounts.clientFor(ACCOUNT_ID));
    await env.run(
      env.harness.accounts.observer.rateLimited(
        client,
        new GitHubRateLimitError({
          resetAt: new Date(Date.now() + 60_000),
          retryAfter: 60,
          kind: "secondary",
        }),
      ),
    );
    const gate = await env.run(env.gate());
    expect(await env.run(gate.clientForRepo(REPO.id, "core"))).toBeNull();
    expect(await env.run(gate.clientForRepo(REPO.id))).toBeNull();
  });

  it("reuses the DB rows of a repo the probe proved unchanged", async () => {
    const env = await setup();
    const existing = [pr(1), pr(2)];

    const result = await syncRepo(env, context(existing, { unchangedRepoIds: new Set([REPO.id]) }));

    expect(result).toEqual({ prs: existing, listed: false });
    expect(env.log).toEqual([]);
  });

  it("records the signature of a list that fully landed", async () => {
    const env = await setup({
      listOpen: () => Effect.succeed([pr(1, { updatedAt: "2026-01-03T00:00:00Z" }), pr(2)]),
    });

    await syncRepo(env, context([]));

    expect(env.state.listed(REPO.id)?.signature).toEqual({
      count: 2,
      latestUpdatedAt: "2026-01-03T00:00:00Z",
    });
  });

  it("sizes new PRs in the same write that lands them", async () => {
    const env = await setup({ listOpen: () => Effect.succeed([pr(1)]) });

    await syncRepo(env, context([]));

    expect(env.log).toEqual(["list:graphql", "diffStats", "upsert:head-1"]);
    expect(env.upserts[0]?.rows[0]).toMatchObject({ changedFiles: 1, statsHeadSha: "head-1" });
    const heads = await env.run(env.harness.prService.diffStatsHeads());
    expect(heads.get("repo-1:1")).toBe("head-1");
  });
});

describe("syncRepoOpenPrs stack membership", () => {
  const STACKED = { number: 4, position: 2 };

  it("writes a listed stack as authoritative, joining or leaving", async () => {
    const env = await setup({
      listOpen: () => Effect.succeed([pr(1, { stack: STACKED }), pr(2)]),
    });

    await syncRepo(env, context([pr(1), pr(2, { stack: STACKED })]));

    expect(env.upserts).toHaveLength(1);
    expect(env.upserts[0]?.rows.map((row) => row.stack)).toEqual([
      stackSeen(STACKED),
      stackSeen(null),
    ]);
  });

  it("announces a stack a member joined, left, or moved in", async () => {
    const env = await setup({
      listOpen: () =>
        Effect.succeed([pr(1, { stack: STACKED }), pr(2, { stack: { number: 9, position: 1 } })]),
    });

    await syncRepo(env, context([pr(1), pr(2, { stack: { number: 9, position: 1 } })]));

    expect(env.harness.recorded.staleStacks).toEqual([`${REPO.id}:4`]);
  });

  it("keeps the stored stack when GitHub refused the stack fields", async () => {
    const stored = pr(1, { stack: STACKED });
    const env = await setup({ listOpen: () => Effect.succeed([pr(1)]), stacks: "refused" });

    const result = await syncRepo(env, context([stored]));

    expect(env.upserts[0]?.rows[0]?.stack).toEqual(STACK_UNSEEN);
    expect(result?.prs[0]?.stack).toEqual(STACKED);
  });

  it("announces no stack when the list couldn't see them", async () => {
    const stored = [pr(1, { stack: STACKED }), pr(2, { stack: { number: 9, position: 1 } })];
    const env = await setup({ listOpen: () => Effect.succeed([pr(1), pr(2)]), stacks: "refused" });

    const result = await syncRepo(env, context(stored));

    expect(env.harness.recorded.staleStacks).toEqual([]);
    expect(result?.prs.map((p) => p.stack)).toEqual([STACKED, { number: 9, position: 1 }]);
  });

  it("keeps the stored stack across a REST fallback", async () => {
    const stored = pr(1, { stack: STACKED });
    const env = await setup({
      listOpen: () => Effect.fail(graphqlLimit()),
      listOpenRest: () => Effect.succeed([pr(1)]),
    });

    const result = await syncRepo(env, context([stored]));

    expect(env.upserts[0]?.rows[0]?.stack).toEqual(STACK_UNSEEN);
    expect(result?.prs[0]?.stack).toEqual(STACKED);
  });

  it("stops asking a host that predates stacks, for that account and a while only", async () => {
    const env = await setup({ listOpen: () => Effect.succeed([pr(1)]), stacks: "unsupported" });
    const realNow = Date.now;

    await syncRepo(env, context([]));
    await syncRepo(env, context([]));
    try {
      const later = realNow() + 31 * 60 * 1000;
      Date.now = () => later;
      await syncRepo(env, context([]));
    } finally {
      Date.now = realNow;
    }

    expect(env.log.filter((l) => l.startsWith("list:"))).toEqual([
      "list:graphql",
      "list:graphql:no-stacks",
      "list:graphql",
    ]);
  });

  it("records whether the landed list held a stack", async () => {
    const env = await setup({ listOpen: () => Effect.succeed([pr(1, { stack: STACKED })]) });

    await syncRepo(env, context([]));

    expect(env.state.listed(REPO.id)?.hasStacks).toBe(true);
  });
});

describe("reading only what moved", () => {
  const OLD = "2026-01-01T00:00:00Z";
  const NEW = "2026-01-02T00:00:00Z";
  const stored = [pr(1, { updatedAt: OLD }), pr(2, { updatedAt: OLD })];
  const listed = (count: number): ListedSignature => ({
    signature: { count, latestUpdatedAt: OLD },
    listedAt: Date.now() - 60_000,
    fullListedAt: Date.now() - 10 * 60_000,
    hasStacks: false,
    truncated: false,
  });

  const run = async (
    env: Env,
    probed: OpenPrListSignature,
    existing: PullRequest[] = stored,
    truncated = false,
  ) => {
    env.state.recordListing(REPO.id, { ...listed(existing.length), truncated });
    const ctx = context(existing, { probedSignatures: new Map([[REPO.id, probed]]) });
    return syncRepo(env, ctx);
  };

  it("reads the PRs updated since the last list, and writes only those", async () => {
    const env = await setup({
      listOpen: (since) =>
        Effect.succeed(since ? [pr(2, { updatedAt: NEW, headSha: "moved" })] : stored),
    });

    const result = await run(env, { count: 2, latestUpdatedAt: NEW });

    expect(env.log).toContain(`list:graphql:since=${OLD}`);
    expect(env.log).toContain("closed-since");
    expect(env.upserts.map((u) => u.rows.map((r) => r.id))).toEqual([["repo-1:2"]]);
    expect(result?.prs.map((p) => [p.id, p.headSha]).sort()).toEqual([
      ["repo-1:1", "head-1"],
      ["repo-1:2", "moved"],
    ]);
    expect(env.state.listed(REPO.id)?.signature).toEqual({ count: 2, latestUpdatedAt: NEW });
  });

  it("keeps the full-list clock running, so the safety net still comes round", async () => {
    const env = await setup({ listOpen: () => Effect.succeed([pr(2, { updatedAt: NEW })]) });
    const previous = listed(2);
    env.state.recordListing(REPO.id, previous);
    const probed = { count: 2, latestUpdatedAt: NEW };

    await syncRepo(env, context(stored, { probedSignatures: new Map([[REPO.id, probed]]) }));

    expect(env.log).toContain(`list:graphql:since=${OLD}`);
    expect(env.state.listed(REPO.id)?.fullListedAt).toBe(previous.fullListedAt);
  });

  it("drops a PR that closed since, so the cycle archives it", async () => {
    const env = await setup({
      listOpen: () => Effect.succeed([]),
      listClosedSince: () => Effect.succeed([2]),
    });

    const result = await run(env, { count: 1, latestUpdatedAt: OLD });

    expect(result?.prs.map((p) => p.id)).toEqual(["repo-1:1"]);
    expect(result?.listed).toBe(true);
    expect(env.upserts.flatMap((u) => u.rows)).toEqual([]);
  });

  it("lists in full when the result disagrees with the probe's count", async () => {
    const env = await setup({
      listOpen: (since) => Effect.succeed(since ? [] : [pr(1, { updatedAt: OLD })]),
    });

    const result = await run(env, { count: 1, latestUpdatedAt: OLD });

    expect(env.log).toContain("list:graphql");
    expect(result?.prs.map((p) => p.id)).toEqual(["repo-1:1"]);
  });

  it("trusts a list cut at the cap without counting it", async () => {
    const env = await setup({
      listOpen: (since) => Effect.succeed(since ? [pr(2, { updatedAt: NEW })] : stored),
    });

    const result = await run(env, { count: 5801, latestUpdatedAt: NEW }, stored, true);

    expect(env.log.filter((l) => l.startsWith("list:graphql"))).toEqual([
      `list:graphql:since=${OLD}`,
    ]);
    expect(result?.prs).toHaveLength(2);
  });

  it("lists in full when the closed PRs couldn't all be read", async () => {
    const env = await setup({ listClosedSince: () => Effect.succeed(null) });

    await run(env, { count: 2, latestUpdatedAt: NEW });

    expect(env.log.filter((l) => l.startsWith("list:graphql"))).toEqual([
      `list:graphql:since=${OLD}`,
      "list:graphql",
    ]);
  });
});

describe("probeRepos", () => {
  const signature = { count: 2, latestUpdatedAt: "2026-01-03T00:00:00Z" };
  const listedAt = (at: number): ListedSignature => ({
    signature,
    listedAt: at,
    fullListedAt: at,
    hasStacks: false,
    truncated: false,
  });

  const probe = (env: Env, repos = [REPO], reuse = true) =>
    env.run(
      Effect.gen(function* () {
        const gate = yield* env.gate(repos.map((r) => r.id));
        return yield* probeRepos(env.github, gate, env.state, repos, reuse);
      }),
    );

  it("skips only repos whose probed signature matches a recent list", async () => {
    const other = { ...REPO, id: "repo-2", fullName: "octo/other" };
    const env = await setup({
      probe: () =>
        Effect.succeed(
          new Map([
            ["octo/repo", signature],
            ["octo/other", { ...signature, count: 3 }],
          ]),
        ),
    });
    env.state.recordListing("repo-1", listedAt(Date.now()));
    env.state.recordListing("repo-2", listedAt(Date.now()));

    const { unchanged } = await probe(env, [REPO, other]);

    expect([...unchanged]).toEqual(["repo-1"]);
    expect(env.log).toEqual(["probe"]);
  });

  it("a list cut at the cap is unchanged when its newest update is", async () => {
    const env = await setup({
      probe: () => Effect.succeed(new Map([["octo/repo", { ...signature, count: 5801 }]])),
    });
    env.state.recordListing(REPO.id, { ...listedAt(Date.now()), truncated: true });

    const probed = await probe(env);

    expect([...probed.unchanged]).toEqual([REPO.id]);
  });

  it("a manual sync probes, but proves nothing unchanged", async () => {
    const big = { ...signature, count: 250 };
    const env = await setup({ probe: () => Effect.succeed(new Map([["octo/repo", big]])) });
    env.state.recordListing(REPO.id, { ...listedAt(Date.now()), signature: big });

    const probed = await probe(env, [REPO], false);

    expect(probed.unchanged.size).toBe(0);
    expect(probed.signatures.get(REPO.id)).toEqual(big);
  });

  it("does not probe for repos without a recent list", async () => {
    const env = await setup();
    env.state.recordListing(REPO.id, listedAt(Date.now() - 31 * 60 * 1000));

    const { unchanged } = await probe(env);

    expect(unchanged.size).toBe(0);
    expect(env.log).toEqual([]);
  });

  it("never skips a repo holding a stack", async () => {
    const env = await setup({ probe: () => Effect.succeed(new Map([["octo/repo", signature]])) });
    env.state.recordListing(REPO.id, { ...listedAt(Date.now()), hasStacks: true });

    const { unchanged } = await probe(env);

    expect(unchanged.size).toBe(0);
    expect(env.log).toEqual([]);
  });

  const moved = (count: number) => ({ count, latestUpdatedAt: "2026-01-09T00:00:00Z" });
  const planFor = async (stored: Partial<ListedSignature>, probed: OpenPrListSignature | null) => {
    const env = await setup({
      probe: () => Effect.succeed(new Map(probed ? [["octo/repo", probed]] : [])),
    });
    env.state.recordListing(REPO.id, { ...listedAt(Date.now()), ...stored });
    const { unchanged, signatures } = await probe(env);
    if (unchanged.has(REPO.id)) return "reuse";
    return signatures.has(REPO.id) ? "delta" : "full";
  };

  it("lists a small repo in full, and reads a big one by what moved", async () => {
    const stored = (count: number) => ({ signature: { ...signature, count } });
    expect(await planFor(stored(40), moved(41))).toBe("full");
    expect(await planFor(stored(200), moved(200))).toBe("full");
    expect(await planFor(stored(250), moved(250))).toBe("delta");
  });

  it("reads a big stacked repo by what moved, never reusing its list", async () => {
    const big = { ...signature, count: 400 };
    expect(await planFor({ signature: big, hasStacks: true }, big)).toBe("delta");
  });

  it("never skips a repo the probe didn't answer for", async () => {
    expect(await planFor({}, null)).toBe("full");
  });
});

describe("settleVanishedPrs", () => {
  const stacked = (n: number, position: number) => pr(n, { stack: { number: 4, position } });

  const settle = async (env: Env, vanished: PullRequest[]) => {
    // The vanished PRs are open in the mirror before the cycle notices.
    await env.run(env.harness.prService.upsertPrs(vanished.map(unseenStack)));
    const ids = await env.run(
      Effect.gen(function* () {
        const gate = yield* env.gate();
        return yield* settleVanishedPrs(
          { github: env.github, mirror: env.mirror },
          gate,
          vanished,
          new Map([[REPO.id, REPO]]),
          new Map(vanished.map((p) => [p.id, p])),
        );
      }),
    );
    const rows = await env.run(
      Effect.forEach(vanished, (p) => env.harness.prService.getPr(p.id)).pipe(Effect.orDie),
    );
    return { ids, status: new Map(rows.map((r) => [r.id, r.status])) };
  };

  it("resolves every vanished PR of a repo in one batched read", async () => {
    const env = await setup({
      getMany: (numbers) =>
        Effect.succeed(
          new Map(
            numbers
              .filter((n) => n !== 3)
              .map((n): [number, ObservedPr] => [
                n,
                {
                  ...unseenStack(pr(n)),
                  status: n === 1 ? "merged" : "closed",
                  closedAt: "2026-01-05T00:00:00Z",
                },
              ]),
          ),
        ),
    });

    const { ids, status } = await settle(env, [pr(1), pr(2), pr(3)]);

    expect(env.log.filter((l) => l.startsWith("getMany"))).toEqual(["getMany:1,2,3"]);
    expect(ids.sort()).toEqual(["repo-1:1", "repo-1:2", "repo-1:3"]);
    // A PR GitHub can no longer show is recorded closed.
    expect([...status]).toEqual([
      ["repo-1:1", "merged"],
      ["repo-1:2", "closed"],
      ["repo-1:3", "closed"],
    ]);
  });

  it("leaves them open for the next cycle when the read fails", async () => {
    const env = await setup({ getMany: () => Effect.fail(graphqlLimit()) });

    const { ids, status } = await settle(env, [pr(1)]);

    expect(ids).toEqual([]);
    expect(status.get("repo-1:1")).toBe("open");
  });

  it("announces a stack once, however many of its layers closed", async () => {
    const env = await setup({
      getMany: (numbers) =>
        Effect.succeed(
          new Map(
            numbers.map((n): [number, ObservedPr] => [
              n,
              { ...unseenStack(pr(n)), status: "merged", closedAt: "2026-01-05T00:00:00Z" },
            ]),
          ),
        ),
    });

    await settle(env, [stacked(1, 1), stacked(2, 2), pr(3)]);

    expect(env.harness.recorded.staleStacks).toEqual([`${REPO.id}:4`]);
  });
});

describe("change detection", () => {
  it("movedRangePrIds ignores new PRs and catches head or base moves", () => {
    const existing = new Map([
      ["repo-1:1", pr(1)],
      ["repo-1:2", pr(2)],
    ]);
    expect(
      movedRangePrIds([pr(1, { headSha: "x" }), pr(2, { baseSha: "y" }), pr(3)], existing),
    ).toEqual(["repo-1:1", "repo-1:2"]);
    expect(movedRangePrIds([pr(1), pr(2)], existing)).toEqual([]);
  });

  it("openListMoved flags new PRs and list-visible edits only", () => {
    const existing = new Map([["repo-1:1", pr(1)]]);
    expect(openListMoved([pr(1)], existing)).toBe(false);
    expect(openListMoved([pr(1, { isDraft: true })], existing)).toBe(true);
    expect(openListMoved([pr(1, { stack: { number: 4, position: 1 } })], existing)).toBe(true);
    expect(openListMoved([pr(1), pr(2)], existing)).toBe(true);
  });
});
