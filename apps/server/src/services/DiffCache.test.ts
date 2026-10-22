import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db";
import { prDiffFiles, pullRequests } from "../db/schema";
import { GitHubAuthError, GitHubRateLimitError } from "../domain/errors";
import { DbService } from "./Db";
import {
  type CachedDiffFile,
  DiffCacheService,
  DiffCacheServiceLive,
  type FetchedFor,
  getOrFetchDiffFiles,
  hasCompleteCachedFiles,
  readCurrentHeadFiles,
  readCurrentHeadPatch,
  shouldServeCachedFilesOnFetchError,
} from "./DiffCache";
import { GitHubGateway, PR_FILES_MAX_COUNT } from "./GitHub";
import { GitHubEtagCache } from "./GitHubEtagCache";
import { SettingsService } from "./Settings";

function cachedFile(path: string): CachedDiffFile {
  return {
    path,
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: null,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

const AT_A: FetchedFor = { id: "pr-1", headSha: "A", baseSha: "base" };

function freshDb(): Db {
  const db = createDb(":memory:");
  (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
    "PRAGMA foreign_keys = OFF",
  );
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

function runDiffCache<A>(
  db: Db,
  use: (s: DiffCacheService["Type"]) => Effect.Effect<A, never, DbService>,
): Promise<A> {
  return Effect.runPromise(
    Effect.flatMap(DiffCacheService, use).pipe(
      Effect.provide(DiffCacheServiceLive),
      Effect.provide(Layer.succeed(DbService, { db })),
    ),
  );
}

function cacheFiles(db: Db, fetchedFor: FetchedFor, files: CachedDiffFile[]): Promise<void> {
  return runDiffCache(db, (s) => s.cacheFiles(fetchedFor, files));
}

function cachedPrIds(db: Db): Promise<string[]> {
  return runDiffCache(db, (s) => s.getPrIdsWithCachedDiffs());
}

describe("hasCompleteCachedFiles", () => {
  it("accepts cached files when no expected count is available", () => {
    expect(hasCompleteCachedFiles([cachedFile("src/a.ts")])).toBe(true);
  });

  it("rejects cached files below the PR changed-files count", () => {
    expect(hasCompleteCachedFiles([cachedFile("src/a.ts")], 2)).toBe(false);
  });

  it("caps the expected count to the GitHub files endpoint range", () => {
    const files = Array.from({ length: PR_FILES_MAX_COUNT }, (_, i) => cachedFile(`src/${i}.ts`));
    expect(hasCompleteCachedFiles(files, PR_FILES_MAX_COUNT + 1)).toBe(true);
  });

  // GitHub counts file *entries* in `changed_files`, and reports a path whose
  // file type changed twice (removed + added). `pr_diff_files` is keyed on
  // (prId, path), so the row count is permanently short of `changed_files` for
  // such a PR — without the recorded fetch size, every page view re-fetched
  // all 30 pages.
  it("accepts a cache holding every row the last fetch produced", () => {
    const files = Array.from({ length: 2998 }, (_, i) => cachedFile(`src/${i}.ts`));
    expect(hasCompleteCachedFiles(files, 3000)).toBe(false);
    expect(hasCompleteCachedFiles(files, 3000, 2998)).toBe(true);
  });

  it("falls back to the changed-files count when no fetch size was recorded", () => {
    expect(hasCompleteCachedFiles([cachedFile("src/a.ts")], 2, null)).toBe(false);
  });

  it("rejects a cache that lost rows since the recorded fetch", () => {
    expect(hasCompleteCachedFiles([cachedFile("src/a.ts")], undefined, 2)).toBe(false);
  });
});

describe("shouldServeCachedFilesOnFetchError", () => {
  it("serves existing cached files when GitHub rate-limits the refresh", () => {
    const cached = [cachedFile("src/a.ts")];
    const error = new GitHubRateLimitError({
      resetAt: new Date("2026-01-01T00:01:00.000Z"),
      kind: "primary",
    });

    expect(shouldServeCachedFilesOnFetchError(cached, error)).toBe(true);
  });

  it("does not mask rate limits when there is no cache to render", () => {
    const error = new GitHubRateLimitError({
      resetAt: new Date("2026-01-01T00:01:00.000Z"),
      kind: "primary",
    });

    expect(shouldServeCachedFilesOnFetchError(null, error)).toBe(false);
  });

  it("does not serve cached files for non-rate-limit GitHub errors", () => {
    const cached = [cachedFile("src/a.ts")];
    const error = new GitHubAuthError({ message: "Invalid or expired GitHub token" });

    expect(shouldServeCachedFilesOnFetchError(cached, error)).toBe(false);
  });
});

describe("cacheFiles", () => {
  it("is idempotent for duplicate rows with the same deterministic id", async () => {
    const db = freshDb();

    const first = cachedFile("src/a.ts");
    const second: CachedDiffFile = {
      ...first,
      oldPath: "src/old-a.ts",
      additions: 3,
      patch: "@@ second",
      fetchedAt: "2026-01-01T00:01:00.000Z",
    };

    await cacheFiles(db, AT_A, [first, second]);

    const rows = db.select().from(prDiffFiles).where(eq(prDiffFiles.prId, "pr-1")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe("src/a.ts");
    expect(rows[0]?.oldPath).toBe("src/old-a.ts");
    expect(rows[0]?.additions).toBe(3);
    expect(rows[0]?.patch).toBe("@@ second");
  });

  it("records the stored row count, not the length of a list with repeats", async () => {
    const db = freshDb();
    seedPr(db);

    // GitHub reports a type-changed path twice: once removed, once added.
    await cacheFiles(db, AT_A, [
      cachedFile("src/a.ts"),
      cachedFile("AGENTS.md"),
      cachedFile("AGENTS.md"),
    ]);

    const pr = db.select().from(pullRequests).where(eq(pullRequests.id, "pr-1")).get();
    expect(pr?.diffFilesCachedCount).toBe(2);
    expect(pr?.changedFiles).toBe(2);
    // Not 3 — the repeated path must not be counted twice in the diff stats.
    expect(pr?.additions).toBe(2);
  });
});

describe("files cached for a PR's current head and base", () => {
  it("are served until the PR's head or base moves", async () => {
    for (const move of [{ headSha: "B" }, { baseSha: "base-2" }]) {
      const db = freshDb();
      seedPr(db);
      await cacheFiles(db, AT_A, [{ ...cachedFile("src/a.ts"), patch: "@@ a" }]);
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
    const github = {
      prs: {
        files: () =>
          Effect.sync(() => {
            fetches++;
            if (fetches === 1) {
              db.update(pullRequests)
                .set({ headSha: "B" })
                .where(eq(pullRequests.id, "pr-1"))
                .run();
            }
            return [
              {
                filename: `src/fetch-${fetches}.ts`,
                previousFilename: null,
                status: "modified",
                additions: 1,
                deletions: 0,
                patch: null,
              },
            ];
          }),
      },
    } as unknown as GitHubGateway["Type"];
    const getOrFetch = () =>
      Effect.runPromise(
        getOrFetchDiffFiles("pr-1", "o/r", 1, "token").pipe(
          Effect.provide(DiffCacheServiceLive),
          Effect.provideService(GitHubGateway, github),
          Effect.provideService(DbService, { db }),
          Effect.provideService(GitHubEtagCache, {} as never),
          Effect.provideService(SettingsService, {} as never),
        ),
      );

    await getOrFetch();
    expect(readCurrentHeadFiles(db, ["pr-1"]).has("pr-1")).toBe(false);

    expect((await getOrFetch()).map((f) => f.path)).toEqual(["src/fetch-2.ts"]);
    expect(fetches).toBe(2);
    expect(
      readCurrentHeadFiles(db, ["pr-1"])
        .get("pr-1")
        ?.map((f) => f.path),
    ).toEqual(["src/fetch-2.ts"]);
  });
});
