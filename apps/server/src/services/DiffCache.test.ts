import { describe, expect, it } from "bun:test";
import type { ServerEventMessage } from "@revv/shared";
import { eq } from "drizzle-orm";
import { type Context, Effect, Layer } from "effect";
import { createDb, type Db } from "../db";
import { prDiffFiles, pullRequests } from "../db/schema";
import { type GitHubError, GitHubRateLimitError } from "../domain/errors";
import { DbService } from "./Db";
import {
  DiffCacheService,
  DiffCacheServiceLive,
  type FetchedFor,
  readCurrentHeadFiles,
  readCurrentHeadPatch,
} from "./DiffCache";
import { GitHubGateway } from "./github/gateway";
import type { PrFileMeta } from "./github/pulls";
import { githubClient } from "./github/transport";
import { Realtime } from "./Realtime";

function githubFile(path: string, overrides: Partial<PrFileMeta> = {}): PrFileMeta {
  return {
    filename: path,
    previousFilename: null,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: null,
    ...overrides,
  };
}

const AT_A: FetchedFor = { id: "pr-1", headSha: "A", baseSha: "base" };
const PR = { id: "pr-1", externalId: 1 };
const CLIENT = githubClient("github.com", "token", "acc-1");

function freshDb(): Db {
  const db = createDb(":memory:");
  db.$client.run("PRAGMA foreign_keys = OFF");
  return db;
}

function seedPr(db: Db): void {
  db.insert(pullRequests)
    .values({
      id: "pr-1",
      externalId: 1,
      repositoryId: "repo-1",
      title: "t",
      authorLogin: "alex",
      sourceBranch: "feat",
      targetBranch: "main",
      url: "https://example.test/pr/1",
      headSha: AT_A.headSha,
      baseSha: AT_A.baseSha,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      fetchedAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
}

/** A diff cache over `db` whose GitHub answers `files()`; the pushes it sends land in `pushed`. */
function diffCache(
  db: Db,
  files: () => Effect.Effect<PrFileMeta[], GitHubError>,
): {
  readonly run: <A, E>(
    use: (s: Context.Service.Shape<typeof DiffCacheService>) => Effect.Effect<A, E>,
  ) => Promise<A>;
  readonly pushed: ServerEventMessage[];
} {
  const pushed: ServerEventMessage[] = [];
  const layer = DiffCacheServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DbService, { db }),
        Layer.succeed(GitHubGateway, {
          prs: { files: () => files() },
        } as unknown as Context.Service.Shape<typeof GitHubGateway>),
        Layer.succeed(Realtime, {
          toPr: (_prId: string, msg: ServerEventMessage) =>
            Effect.sync(() => void pushed.push(msg)),
        } as unknown as Context.Service.Shape<typeof Realtime>),
      ),
    ),
  );
  return {
    run: (use) =>
      Effect.runPromise(Effect.flatMap(DiffCacheService, use).pipe(Effect.provide(layer))),
    pushed,
  };
}

const fetchFiles = (cache: ReturnType<typeof diffCache>) =>
  cache.run((s) => s.getOrFetch(PR, "o/r", CLIENT));

async function cacheFiles(db: Db, files: PrFileMeta[]): Promise<void> {
  await fetchFiles(diffCache(db, () => Effect.succeed(files)));
}

function cachedPrIds(db: Db): Promise<string[]> {
  return diffCache(db, () => Effect.succeed([])).run((s) => s.getPrIdsWithCachedDiffs());
}

/** What answers `getOrFetch` once the stored PR row says `columns`, and whether GitHub was asked. */
async function answerAfter(
  db: Db,
  columns: Partial<typeof pullRequests.$inferInsert>,
  refetch: () => Effect.Effect<PrFileMeta[], GitHubError> = () => Effect.succeed([]),
) {
  if (Object.keys(columns).length > 0) {
    db.update(pullRequests).set(columns).where(eq(pullRequests.id, "pr-1")).run();
  }
  let fetches = 0;
  const answer = await fetchFiles(
    diffCache(db, () =>
      Effect.suspend(() => {
        fetches++;
        return refetch();
      }),
    ),
  ).catch((error: unknown) => ({ error }));
  return { answer, fetches };
}

const files = (count: number) => Array.from({ length: count }, (_, i) => githubFile(`src/${i}.ts`));

describe("a cached diff", () => {
  // GitHub counts file *entries* in `changed_files`, and reports a path whose
  // file type changed twice (removed + added). `pr_diff_files` is keyed on
  // (prId, path), so the row count is permanently short of `changed_files` for
  // such a PR.
  it("is served for the current head and base, whatever changed_files says", async () => {
    const db = freshDb();
    seedPr(db);
    await cacheFiles(db, files(2998));
    const { answer, fetches } = await answerAfter(db, { changedFiles: 3000 });
    expect(fetches).toBe(0);
    expect(answer).toMatchObject({ source: "cache" });
  });

  it("is fetched when nothing is cached, and a GitHub failure fails the read", async () => {
    const db = freshDb();
    seedPr(db);
    const { answer, fetches } = await answerAfter(db, {}, () =>
      Effect.fail(new GitHubRateLimitError({ resetAt: new Date(), kind: "primary" })),
    );
    expect(fetches).toBe(1);
    expect(answer).toMatchObject({ error: { _tag: "GitHubRateLimitError" } });
  });
});

describe("getOrFetch writes", () => {
  it("one row per path, the last entry winning", async () => {
    const db = freshDb();
    seedPr(db);

    await cacheFiles(db, [
      githubFile("src/a.ts"),
      githubFile("src/a.ts", {
        previousFilename: "src/old-a.ts",
        additions: 3,
        patch: "@@ second",
      }),
    ]);

    const rows = db.select().from(prDiffFiles).where(eq(prDiffFiles.prId, "pr-1")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.oldPath).toBe("src/old-a.ts");
    expect(rows[0]?.additions).toBe(3);
    expect(rows[0]?.patch).toBe("@@ second");
  });

  it("record the stored row count, not the length of a list with repeats", async () => {
    const db = freshDb();
    seedPr(db);

    // GitHub reports a type-changed path twice: once removed, once added.
    await cacheFiles(db, [
      githubFile("src/a.ts"),
      githubFile("AGENTS.md"),
      githubFile("AGENTS.md"),
    ]);

    const pr = db.select().from(pullRequests).where(eq(pullRequests.id, "pr-1")).get();
    expect(pr?.diffFilesCachedCount).toBe(2);
    expect(pr?.changedFiles).toBe(2);
    expect(pr?.additions).toBe(2);
  });

  it("announce the diff after it is stored", async () => {
    const db = freshDb();
    seedPr(db);
    const cache = diffCache(db, () => Effect.succeed([githubFile("src/a.ts")]));

    await fetchFiles(cache);

    expect(cache.pushed).toEqual([{ type: "diff:cached", data: { prId: "pr-1", headSha: "A" } }]);
  });
});

describe("files cached for a PR's current head and base", () => {
  it("are served until the PR's head or base moves", async () => {
    for (const move of [{ headSha: "B" }, { baseSha: "base-2" }]) {
      const db = freshDb();
      seedPr(db);
      await cacheFiles(db, [githubFile("src/a.ts", { patch: "@@ a" })]);
      expect(
        readCurrentHeadFiles(db, ["pr-1"])
          .get("pr-1")
          ?.map((f) => f.path),
      ).toEqual(["src/a.ts"]);
      expect(readCurrentHeadPatch(db, "pr-1", "src/a.ts")).toBe("@@ a");
      expect(await cachedPrIds(db)).toEqual(["pr-1"]);

      db.update(pullRequests).set(move).where(eq(pullRequests.id, "pr-1")).run();

      expect(readCurrentHeadFiles(db, ["pr-1"]).has("pr-1")).toBe(false);
      expect(readCurrentHeadPatch(db, "pr-1", "src/a.ts")).toBeNull();
      expect(await cachedPrIds(db)).toEqual([]);
    }
  });

  it("include an empty diff, which is not fetched again", async () => {
    const db = freshDb();
    seedPr(db);
    let fetches = 0;
    const cache = diffCache(db, () =>
      Effect.sync(() => {
        fetches++;
        return [];
      }),
    );

    await fetchFiles(cache);
    const second = await fetchFiles(cache);

    expect(fetches).toBe(1);
    expect(second).toEqual({ files: [], source: "cache" });
    expect(readCurrentHeadFiles(db, ["pr-1"]).get("pr-1")).toEqual([]);
  });

  it("never include rows cached before files carried a head stamp", async () => {
    const db = freshDb();
    seedPr(db);
    db.insert(prDiffFiles)
      .values({
        id: "pr-1\0src/a.ts",
        prId: "pr-1",
        path: "src/a.ts",
        status: "modified",
        fetchedAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    expect(readCurrentHeadFiles(db, ["pr-1"]).has("pr-1")).toBe(false);
    expect(await cachedPrIds(db)).toEqual([]);
  });

  it("are refetched, not served, when the fetch raced a head move", async () => {
    const db = freshDb();
    seedPr(db);
    let fetches = 0;
    const cache = diffCache(db, () =>
      Effect.sync(() => {
        fetches++;
        if (fetches === 1) {
          db.update(pullRequests).set({ headSha: "B" }).where(eq(pullRequests.id, "pr-1")).run();
        }
        return [githubFile(`src/fetch-${fetches}.ts`)];
      }),
    );

    await fetchFiles(cache);
    expect(readCurrentHeadFiles(db, ["pr-1"]).has("pr-1")).toBe(false);

    expect((await fetchFiles(cache)).files.map((f) => f.path)).toEqual(["src/fetch-2.ts"]);
    expect(fetches).toBe(2);
    expect(
      readCurrentHeadFiles(db, ["pr-1"])
        .get("pr-1")
        ?.map((f) => f.path),
    ).toEqual(["src/fetch-2.ts"]);
  });
});
