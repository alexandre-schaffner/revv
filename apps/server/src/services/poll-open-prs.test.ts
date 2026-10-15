import { describe, expect, it } from "bun:test";
import type { PullRequest, Repository } from "@revv/shared";
import { Effect } from "effect";
import { createDb, type Db } from "../db/index";
import { account, user } from "../db/schema/auth";
import { GitHubRateLimitError } from "../domain/errors";
import { DbService } from "./Db";
import { GitHubEtagCache } from "./GitHubEtagCache";
import type { OpenPrListSignature } from "./github-graphql-prs";
import { makeAccountPauses, openSyncCycle, type PollDeps } from "./poll-cycle";
import {
  findUnchangedRepos,
  type ListedSignature,
  movedRangePrIds,
  openListMoved,
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
  listOpen: () => Effect.Effect<PullRequest[], GitHubRateLimitError>;
  listOpenRest: () => Effect.Effect<PullRequest[]>;
  probe: () => Effect.Effect<Map<string, OpenPrListSignature>>;
}

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
    github: {
      prs: {
        listOpen: () => {
          fakes.log.push("list:graphql");
          return fakes.listOpen();
        },
        listOpenRest: () => {
          fakes.log.push("list:rest");
          return fakes.listOpenRest();
        },
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
      upsertPrs: (rows: PullRequest[]) =>
        Effect.sync(() => {
          fakes.log.push(`upsert:${rows.map((r) => r.headSha).join(",")}`);
        }),
    },
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

function setup(fakes: Partial<Omit<Fakes, "log">> = {}) {
  const db = createDb(":memory:");
  seedAccount(db);
  const all: Fakes = {
    log: [],
    listOpen: () => Effect.succeed([]),
    listOpenRest: () => Effect.succeed([]),
    probe: () => Effect.succeed(new Map()),
    ...fakes,
  };
  const deps = makeDeps(db, all);
  const pauses = makeAccountPauses();
  const openCycle = () => openSyncCycle(deps, pauses, ["acc-1"], new Map([[REPO.id, "acc-1"]]));
  return { db, deps, log: all.log, openCycle };
}

function context(existing: PullRequest[], overrides: Partial<RepoListingContext> = {}) {
  return {
    existingMap: new Map(existing.map((p) => [p.id, p])),
    existingByRepo: Map.groupBy(existing, (p) => p.repositoryId),
    diffStatsHeadByPrId: new Map<string, string | null>(),
    unchangedRepoIds: new Set<string>(),
    listedSignatures: new Map<string, ListedSignature>(),
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

describe("findUnchangedRepos", () => {
  const signature = { count: 2, latestUpdatedAt: "2026-01-03T00:00:00Z" };

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
          return yield* findUnchangedRepos(
            deps,
            cycle,
            [REPO, other],
            new Map([
              ["repo-1", { signature, listedAt: Date.now() }],
              ["repo-2", { signature, listedAt: Date.now() }],
            ]),
          );
        }),
      ),
    );

    expect([...unchanged]).toEqual(["repo-1"]);
    expect(log).toEqual(["probe"]);
  });

  it("does not probe for repos without a recent list", async () => {
    const { db, deps, log, openCycle } = setup();

    const unchanged = await Effect.runPromise(
      provideInfra(
        db,
        Effect.gen(function* () {
          return yield* findUnchangedRepos(
            deps,
            yield* openCycle(),
            [REPO],
            new Map([[REPO.id, { signature, listedAt: Date.now() - 31 * 60 * 1000 }]]),
          );
        }),
      ),
    );

    expect(unchanged.size).toBe(0);
    expect(log).toEqual([]);
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
    expect(openListMoved([pr(1), pr(2)], existing)).toBe(true);
  });
});
