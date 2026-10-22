import { describe, expect, it } from "bun:test";
import type { PullRequest, Repository } from "@revv/shared";
import { Effect } from "effect";
import { createDb, type Db } from "../db/index";
import { account, user } from "../db/schema/auth";
import { GitHubRateLimitError } from "../domain/errors";
import { type ObservedPr, STACK_UNSEEN, stackSeen } from "../domain/observed-pr";
import { DbService } from "./Db";
import { GitHubEtagCache } from "./GitHubEtagCache";
import type { OpenPrList, OpenPrListSignature } from "./github-graphql-prs";
import { makeAccountPauses, openSyncCycle, type PollDeps } from "./poll-cycle";
import {
  archiveClosedPrs,
  decideListing,
  type ListedSignature,
  movedRangePrIds,
  openListMoved,
  probeRepos,
  type RepoListingContext,
  syncRepoOpenPrs,
} from "./poll-open-prs";
import { SettingsService } from "./Settings";

const REPO: Repository = {
  id: "repo-1",
  provider: "github",
  owner: "octo",
  name: "repo",
  fullName: "octo/repo",
  defaultBranch: "main",
  avatarUrl: null,
  addedAt: "2026-01-01T00:00:00Z",
  cloneStatus: "ready",
  clonePath: null,
  cloneError: null,
  managed: false,
  githubHost: "github.com",
};

function pr(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `repo-1:${number}`,
    externalId: number,
    repositoryId: "repo-1",
    title: `PR ${number}`,
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

function seedAccount(db: Db): void {
  const now = new Date();
  db.insert(user)
    .values({ id: "user-1", name: "U", email: "u@test", createdAt: now, updatedAt: now })
    .run();
  db.insert(account)
    .values({
      id: "acc-1",
      accountId: "1",
      providerId: "github",
      userId: "user-1",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

interface Fakes {
  readonly log: string[];
  listOpen: (updatedSince: string | null) => Effect.Effect<PullRequest[], GitHubRateLimitError>;
  listClosedSince: () => Effect.Effect<number[] | null>;
  listOpenRest: () => Effect.Effect<PullRequest[]>;
  probe: () => Effect.Effect<Map<string, OpenPrListSignature>>;
  stacks?: "listed" | "refused" | "unsupported";
  readonly upserts: Array<{ rows: readonly ObservedPr[] }>;
}

const unseenStack = (pr: PullRequest): ObservedPr => ({ ...pr, stack: STACK_UNSEEN });
const seenStack = (pr: PullRequest): ObservedPr => ({ ...pr, stack: stackSeen(pr.stack) });

function makeDeps(db: Db, fakes: Fakes): PollDeps {
  const deps = {
    db,
    broadcaster: { broadcastToAccount: () => Effect.void, broadcastAll: () => Effect.void },
    tokenProvider: {
      getTokenByAccountId: () => Effect.succeed("token"),
      refreshAccountToken: () => Effect.fail(new Error("no refresh")),
      clearReauthRequired: () => Effect.void,
      markReauthRequired: () => Effect.void,
    },
    remoteUserService: { upsert: () => Effect.void },
    stackService: {
      markStale: (repositoryId: string, stackNumber: number) =>
        Effect.sync(() => {
          fakes.log.push(`stack:${repositoryId}:${stackNumber}`);
        }),
    },
    github: {
      prs: {
        listOpen: (
          _repo: string,
          _repoId: string,
          _token: string,
          _apiBase: string,
          {
            withStacks = true,
            updatedSince = null,
          }: { withStacks?: boolean; updatedSince?: string | null } = {},
        ) => {
          fakes.log.push(
            (withStacks ? "list:graphql" : "list:graphql:no-stacks") +
              (updatedSince ? `:since=${updatedSince}` : ""),
          );
          return fakes.listOpen(updatedSince).pipe(
            Effect.map((prs): OpenPrList => {
              const stacks = withStacks ? (fakes.stacks ?? "listed") : "refused";
              return {
                prs: prs.map(stacks === "listed" ? seenStack : unseenStack),
                hostPredatesStacks: stacks === "unsupported",
              };
            }),
          );
        },
        listOpenRest: () => {
          fakes.log.push("list:rest");
          return fakes.listOpenRest().pipe(Effect.map((prs) => prs.map(unseenStack)));
        },
        listClosedSince: () => {
          fakes.log.push("closed-since");
          return fakes.listClosedSince();
        },
        get: (_repo: string, n: number) => Effect.succeed(pr(n, { status: "merged" })),
        probeOpenLists: () => {
          fakes.log.push("probe");
          return fakes.probe();
        },
        diffStats: (_repo: string, numbers: readonly number[]) => {
          fakes.log.push("diffStats");
          return Effect.succeed(
            new Map(numbers.map((n) => [n, { additions: 1, deletions: 1, changedFiles: 1 }])),
          );
        },
      },
    },
    diffCache: {
      invalidateFilesForPrs: (ids: string[]) =>
        Effect.sync(() => {
          fakes.log.push(`invalidate:${ids.join(",")}`);
        }),
    },
    prService: {
      upsertPrs: (rows: readonly ObservedPr[]) =>
        Effect.sync(() => {
          fakes.log.push(`upsert:${rows.map((r) => r.headSha).join(",")}`);
          fakes.upserts.push({ rows });
        }),
      markPrsClosed: () => Effect.void,
    },
    repoClone: { pruneWorktree: () => Effect.void },
  };
  return deps as unknown as PollDeps;
}

const provideInfra = <A>(
  db: Db,
  eff: Effect.Effect<A, never, DbService | GitHubEtagCache | SettingsService>,
) =>
  eff.pipe(
    Effect.provideService(DbService, { db }),
    Effect.provideService(GitHubEtagCache, {} as never),
    Effect.provideService(SettingsService, {} as never),
  );

function setup(fakes: Partial<Omit<Fakes, "log" | "upserts">> = {}) {
  const db = createDb(":memory:");
  seedAccount(db);
  const all: Fakes = {
    log: [],
    upserts: [],
    listOpen: () => Effect.succeed([]),
    listOpenRest: () => Effect.succeed([]),
    listClosedSince: () => Effect.succeed([]),
    probe: () => Effect.succeed(new Map()),
    ...fakes,
  };
  const deps = makeDeps(db, all);
  const pauses = makeAccountPauses();
  const openCycle = () => openSyncCycle(deps, pauses, ["acc-1"], new Map([[REPO.id, "acc-1"]]));
  return { db, deps, log: all.log, upserts: all.upserts, openCycle };
}

function context(existing: PullRequest[], overrides: Partial<RepoListingContext> = {}) {
  return {
    existingMap: new Map(existing.map((p) => [p.id, p])),
    existingByRepo: Map.groupBy(existing, (p) => p.repositoryId),
    diffStatsHeadByPrId: new Map<string, string | null>(),
    unchangedRepoIds: new Set<string>(),
    probedSignatures: new Map<string, OpenPrListSignature>(),
    listedSignatures: new Map<string, ListedSignature>(),
    stacklessUntil: new Map<string, number>(),
    ...overrides,
  } satisfies RepoListingContext;
}

describe("syncRepoOpenPrs", () => {
  it("drops a moved PR's cached diff before its new head lands", async () => {
    const { db, deps, log, openCycle } = setup({
      listOpen: () =>
        Effect.succeed([pr(1, { headSha: "new", updatedAt: "2026-01-02T00:00:00Z" })]),
    });

    const result = await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          const cycle = yield* openCycle();
          return yield* syncRepoOpenPrs(deps, cycle, context([pr(1, { headSha: "old" })]), REPO);
        }),
      ),
    );

    expect(result?.listed).toBe(true);
    expect(log.indexOf("invalidate:repo-1:1")).toBeGreaterThan(-1);
    expect(log.indexOf("invalidate:repo-1:1")).toBeLessThan(log.indexOf("upsert:new"));
  });

  it("falls back to the REST list when the GraphQL budget runs out", async () => {
    const { db, deps, log, openCycle } = setup({
      listOpen: () =>
        Effect.fail(
          new GitHubRateLimitError({
            resetAt: new Date(Date.now() + 60 * 60 * 1000),
            kind: "primary",
            resource: "graphql",
          }),
        ),
      listOpenRest: () => Effect.succeed([pr(1)]),
    });

    const { result, graphqlLive, restLive } = await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          const cycle = yield* openCycle();
          const result = yield* syncRepoOpenPrs(deps, cycle, context([]), REPO);
          return {
            result,
            graphqlLive: cycle.liveAccountForRepo(REPO.id, "graphql"),
            restLive: cycle.liveAccountForRepo(REPO.id, "core"),
          };
        }),
      ),
    );

    expect(result?.prs.map((p) => p.id)).toEqual(["repo-1:1"]);
    // No diff stats: they are GraphQL too.
    expect(log).toEqual(["list:graphql", "list:rest", "upsert:head-1"]);
    expect(graphqlLive).toBeNull();
    expect(restLive).not.toBeNull();
  });

  it("goes straight to REST while GraphQL is paused, and still pauses everything on a secondary limit", async () => {
    const { db, deps, log, openCycle } = setup({
      listOpen: () =>
        Effect.fail(
          new GitHubRateLimitError({
            resetAt: new Date(Date.now() + 60 * 60 * 1000),
            kind: "primary",
            resource: "graphql",
          }),
        ),
    });

    await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          yield* syncRepoOpenPrs(deps, yield* openCycle(), context([]), REPO);
          // The pause outlives the cycle that hit it.
          const next = yield* openCycle();
          yield* syncRepoOpenPrs(deps, next, context([]), REPO);
          const [acc] = next.accountRows;
          if (!acc) throw new Error("account not hydrated");
          yield* next.tryGuarded(
            acc,
            Effect.fail(
              new GitHubRateLimitError({
                resetAt: new Date(Date.now() + 60_000),
                retryAfter: 60,
                kind: "secondary",
              }),
            ),
          );
          expect(next.liveAccountForRepo(REPO.id, "core")).toBeNull();
          expect(next.liveAccountForRepo(REPO.id)).toBeNull();
        }),
      ),
    );

    expect(log.filter((l) => l.startsWith("list:"))).toEqual([
      "list:graphql",
      "list:rest",
      "list:rest",
    ]);
  });

  it("reuses the DB rows of a repo the probe proved unchanged", async () => {
    const { db, deps, log, openCycle } = setup();
    const existing = [pr(1), pr(2)];

    const result = await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          const cycle = yield* openCycle();
          return yield* syncRepoOpenPrs(
            deps,
            cycle,
            context(existing, { unchangedRepoIds: new Set([REPO.id]) }),
            REPO,
          );
        }),
      ),
    );

    expect(result).toEqual({ prs: existing, listed: false });
    expect(log).toEqual([]);
  });

  it("records the signature of a list that fully landed", async () => {
    const listedSignatures = new Map<string, ListedSignature>();
    const { db, deps, openCycle } = setup({
      listOpen: () => Effect.succeed([pr(1, { updatedAt: "2026-01-03T00:00:00Z" }), pr(2)]),
    });

    await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          yield* syncRepoOpenPrs(deps, yield* openCycle(), context([], { listedSignatures }), REPO);
        }),
      ),
    );

    expect(listedSignatures.get(REPO.id)?.signature).toEqual({
      count: 2,
      latestUpdatedAt: "2026-01-03T00:00:00Z",
    });
  });
});

describe("syncRepoOpenPrs stack membership", () => {
  const STACKED = { number: 4, position: 2 };

  const sync = (env: ReturnType<typeof setup>, existing: PullRequest[], ctx = context(existing)) =>
    Effect.runPromise(
      provideInfra(
        env.db,
        Effect.gen(function* () {
          const cycle = yield* env.openCycle();
          return yield* syncRepoOpenPrs(env.deps, cycle, ctx, REPO);
        }),
      ),
    );

  it("writes a listed stack as authoritative, joining or leaving", async () => {
    const env = setup({ listOpen: () => Effect.succeed([pr(1, { stack: STACKED }), pr(2)]) });

    await sync(env, [pr(1), pr(2, { stack: STACKED })]);

    expect(env.upserts).toHaveLength(1);
    expect(env.upserts[0]?.rows.map((row) => row.stack)).toEqual([
      stackSeen(STACKED),
      stackSeen(null),
    ]);
  });

  it("announces a stack a member joined, left, or moved in", async () => {
    const env = setup({
      listOpen: () =>
        Effect.succeed([pr(1, { stack: STACKED }), pr(2, { stack: { number: 9, position: 1 } })]),
    });

    await sync(env, [pr(1), pr(2, { stack: { number: 9, position: 1 } })]);

    expect(env.log.filter((l) => l.startsWith("stack:"))).toEqual([`stack:${REPO.id}:4`]);
  });

  it("keeps the stored stack when GitHub refused the stack fields", async () => {
    const stored = pr(1, { stack: STACKED });
    const env = setup({ listOpen: () => Effect.succeed([pr(1)]), stacks: "refused" });

    const result = await sync(env, [stored]);

    expect(env.upserts[0]?.rows[0]?.stack).toEqual(STACK_UNSEEN);
    expect(result?.prs[0]?.stack).toEqual(STACKED);
  });

  it("announces no stack when the list couldn't see them", async () => {
    const stored = [pr(1, { stack: STACKED }), pr(2, { stack: { number: 9, position: 1 } })];
    const env = setup({ listOpen: () => Effect.succeed([pr(1), pr(2)]), stacks: "refused" });

    const result = await sync(env, stored);

    expect(env.log.filter((l) => l.startsWith("stack:"))).toEqual([]);
    expect(result?.prs.map((p) => p.stack)).toEqual([STACKED, { number: 9, position: 1 }]);
  });

  it("keeps the stored stack across a REST fallback", async () => {
    const stored = pr(1, { stack: STACKED });
    const env = setup({
      listOpen: () =>
        Effect.fail(
          new GitHubRateLimitError({
            resetAt: new Date(Date.now() + 60 * 60 * 1000),
            kind: "primary",
            resource: "graphql",
          }),
        ),
      listOpenRest: () => Effect.succeed([pr(1)]),
    });

    const result = await sync(env, [stored]);

    expect(env.upserts[0]?.rows[0]?.stack).toEqual(STACK_UNSEEN);
    expect(result?.prs[0]?.stack).toEqual(STACKED);
  });

  it("stops asking a host that predates stacks, for that account and a while only", async () => {
    const env = setup({ listOpen: () => Effect.succeed([pr(1)]), stacks: "unsupported" });
    const ctx = context([]);

    await sync(env, [], ctx);
    await sync(env, [], ctx);
    const [key] = ctx.stacklessUntil.keys();
    if (key === undefined) throw new Error("refusal not remembered");
    expect(key.startsWith("acc-1")).toBe(true);
    ctx.stacklessUntil.set(key, Date.now() - 1);
    await sync(env, [], ctx);

    expect(env.log.filter((l) => l.startsWith("list:"))).toEqual([
      "list:graphql",
      "list:graphql:no-stacks",
      "list:graphql",
    ]);
  });

  it("records whether the landed list held a stack", async () => {
    const env = setup({ listOpen: () => Effect.succeed([pr(1, { stack: STACKED })]) });
    const ctx = context([]);

    await sync(env, [], ctx);

    expect(ctx.listedSignatures.get(REPO.id)?.hasStacks).toBe(true);
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

  const run = (
    env: ReturnType<typeof setup>,
    probed: OpenPrListSignature,
    existing: PullRequest[] = stored,
    truncated = false,
  ) => {
    const ctx = context(existing, {
      listedSignatures: new Map([[REPO.id, { ...listed(existing.length), truncated }]]),
      probedSignatures: new Map([[REPO.id, probed]]),
    });
    return Effect.runPromise(
      provideInfra(
        env.db,
        Effect.gen(function* () {
          return yield* syncRepoOpenPrs(env.deps, yield* env.openCycle(), ctx, REPO);
        }),
      ),
    ).then((result) => ({ result, ctx }));
  };

  it("reads the PRs updated since the last list, and writes only those", async () => {
    const env = setup({
      listOpen: (since) =>
        Effect.succeed(since ? [pr(2, { updatedAt: NEW, headSha: "moved" })] : stored),
    });

    const { result, ctx } = await run(env, { count: 2, latestUpdatedAt: NEW });

    expect(env.log).toContain(`list:graphql:since=${OLD}`);
    expect(env.log).toContain("closed-since");
    expect(env.upserts.map((u) => u.rows.map((r) => r.id))).toEqual([["repo-1:2"]]);
    expect(result?.prs.map((p) => [p.id, p.headSha]).sort()).toEqual([
      ["repo-1:1", "head-1"],
      ["repo-1:2", "moved"],
    ]);
    expect(ctx.listedSignatures.get(REPO.id)?.signature).toEqual({
      count: 2,
      latestUpdatedAt: NEW,
    });
  });

  it("keeps the full-list clock running, so the safety net still comes round", async () => {
    const env = setup({ listOpen: () => Effect.succeed([pr(2, { updatedAt: NEW })]) });
    const before = listed(2).fullListedAt;

    const { ctx } = await run(env, { count: 2, latestUpdatedAt: NEW });

    expect(ctx.listedSignatures.get(REPO.id)?.fullListedAt).toBeLessThanOrEqual(before);
  });

  it("drops a PR that closed since, so the cycle archives it", async () => {
    const env = setup({
      listOpen: () => Effect.succeed([]),
      listClosedSince: () => Effect.succeed([2]),
    });

    const { result } = await run(env, { count: 1, latestUpdatedAt: OLD });

    expect(result?.prs.map((p) => p.id)).toEqual(["repo-1:1"]);
    expect(result?.listed).toBe(true);
    expect(env.upserts.flatMap((u) => u.rows)).toEqual([]);
  });

  it("lists in full when the result disagrees with the probe's count", async () => {
    const env = setup({
      listOpen: (since) => Effect.succeed(since ? [] : [pr(1, { updatedAt: OLD })]),
    });

    const { result } = await run(env, { count: 1, latestUpdatedAt: OLD });

    expect(env.log).toContain("list:graphql");
    expect(result?.prs.map((p) => p.id)).toEqual(["repo-1:1"]);
  });

  it("trusts a list cut at the cap without counting it", async () => {
    const env = setup({
      listOpen: (since) => Effect.succeed(since ? [pr(2, { updatedAt: NEW })] : stored),
    });

    const { result } = await run(env, { count: 5801, latestUpdatedAt: NEW }, stored, true);

    expect(env.log.filter((l) => l.startsWith("list:graphql"))).toEqual([
      `list:graphql:since=${OLD}`,
    ]);
    expect(result?.prs).toHaveLength(2);
  });

  it("lists in full when the closed PRs couldn't all be read", async () => {
    const env = setup({ listClosedSince: () => Effect.succeed(null) });

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

  it("skips only repos whose probed signature matches a recent list", async () => {
    const other = { ...REPO, id: "repo-2", fullName: "octo/other" };
    const { db, deps, log } = setup({
      probe: () =>
        Effect.succeed(
          new Map([
            ["octo/repo", signature],
            ["octo/other", { ...signature, count: 3 }],
          ]),
        ),
    });
    const pauses = makeAccountPauses();

    const unchanged = await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          const cycle = yield* openSyncCycle(
            deps,
            pauses,
            ["acc-1"],
            new Map([
              ["repo-1", "acc-1"],
              ["repo-2", "acc-1"],
            ]),
          );
          return (yield* probeRepos(
            deps,
            cycle,
            [REPO, other],
            new Map([
              ["repo-1", listedAt(Date.now())],
              ["repo-2", listedAt(Date.now())],
            ]),
            true,
          )).unchanged;
        }),
      ),
    );

    expect([...unchanged]).toEqual(["repo-1"]);
    expect(log).toEqual(["probe"]);
  });

  it("a list cut at the cap is unchanged when its newest update is", async () => {
    const { db, deps, openCycle } = setup({
      probe: () => Effect.succeed(new Map([["octo/repo", { ...signature, count: 5801 }]])),
    });

    const probed = await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          return yield* probeRepos(
            deps,
            yield* openCycle(),
            [REPO],
            new Map([[REPO.id, { ...listedAt(Date.now()), truncated: true }]]),
            true,
          );
        }),
      ),
    );

    expect([...probed.unchanged]).toEqual([REPO.id]);
  });

  it("a manual sync probes, but proves nothing unchanged", async () => {
    const big = { ...signature, count: 250 };
    const { db, deps, openCycle } = setup({
      probe: () => Effect.succeed(new Map([["octo/repo", big]])),
    });

    const probed = await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          return yield* probeRepos(
            deps,
            yield* openCycle(),
            [REPO],
            new Map([[REPO.id, { ...listedAt(Date.now()), signature: big }]]),
            false,
          );
        }),
      ),
    );

    expect(probed.unchanged.size).toBe(0);
    expect(probed.signatures.get(REPO.id)).toEqual(big);
  });

  it("does not probe for repos without a recent list", async () => {
    const { db, deps, log, openCycle } = setup();

    const unchanged = await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          return (yield* probeRepos(
            deps,
            yield* openCycle(),
            [REPO],
            new Map([[REPO.id, listedAt(Date.now() - 31 * 60 * 1000)]]),
            true,
          )).unchanged;
        }),
      ),
    );

    expect(unchanged.size).toBe(0);
    expect(log).toEqual([]);
  });

  it("never skips a repo holding a stack", async () => {
    const { db, deps, log, openCycle } = setup({
      probe: () => Effect.succeed(new Map([["octo/repo", signature]])),
    });

    const unchanged = await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          return (yield* probeRepos(
            deps,
            yield* openCycle(),
            [REPO],
            new Map([[REPO.id, { ...listedAt(Date.now()), hasStacks: true }]]),
            true,
          )).unchanged;
        }),
      ),
    );

    expect(unchanged.size).toBe(0);
    expect(log).toEqual([]);
  });
});

describe("archiveClosedPrs", () => {
  it("announces a stack once, however many of its layers closed", async () => {
    const { db, deps, log, openCycle } = setup();
    const stacked = (n: number, position: number) => pr(n, { stack: { number: 4, position } });

    await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          const cycle = yield* openCycle();
          yield* archiveClosedPrs(
            deps,
            cycle,
            [stacked(1, 1), stacked(2, 2), pr(3)],
            new Map([[REPO.id, REPO]]),
          );
        }),
      ),
    );

    expect(log.filter((l) => l.startsWith("stack:"))).toEqual([`stack:${REPO.id}:4`]);
  });
});

describe("decideListing", () => {
  const NOW = Date.parse("2026-01-10T00:00:00Z");
  const OLD = "2026-01-01T00:00:00Z";
  const listed = (count: number, overrides: Partial<ListedSignature> = {}): ListedSignature => ({
    signature: { count, latestUpdatedAt: OLD },
    listedAt: NOW - 60_000,
    fullListedAt: NOW - 60_000,
    hasStacks: false,
    truncated: false,
    ...overrides,
  });
  const moved = (count: number) => ({ count, latestUpdatedAt: "2026-01-09T00:00:00Z" });

  it("reuses an unchanged list, except on a manual sync", () => {
    expect(decideListing(listed(40), { count: 40, latestUpdatedAt: OLD }, NOW, true)).toBe("reuse");
    expect(decideListing(listed(40), { count: 40, latestUpdatedAt: OLD }, NOW, false)).toBe("full");
  });

  it("lists a small repo in full, and reads a big one by what moved", () => {
    expect(decideListing(listed(40), moved(41), NOW, true)).toBe("full");
    expect(decideListing(listed(200), moved(200), NOW, true)).toBe("full");
    expect(decideListing(listed(250), moved(250), NOW, true)).toBe("delta");
  });

  it("never trusts a probe over a stacked repo it can list every cycle", () => {
    const stacked = listed(40, { hasStacks: true });
    expect(decideListing(stacked, { count: 40, latestUpdatedAt: OLD }, NOW, true)).toBe("full");
    const bigStacked = listed(400, { hasStacks: true });
    expect(decideListing(bigStacked, { count: 400, latestUpdatedAt: OLD }, NOW, true)).toBe(
      "delta",
    );
  });

  it("lists in full once the safety net comes round, or with nothing to build on", () => {
    const stale = listed(250, { fullListedAt: NOW - 31 * 60_000 });
    expect(decideListing(stale, moved(250), NOW, true)).toBe("full");
    expect(decideListing(undefined, moved(250), NOW, true)).toBe("full");
    expect(decideListing(listed(250), undefined, NOW, true)).toBe("full");
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
