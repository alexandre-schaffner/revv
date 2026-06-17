import { eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { prDiffFiles } from "../db/schema/index";
import { type GitHubError, GitHubRateLimitError } from "../domain/errors";
import { withDb } from "../effects/with-db";
import { DbService } from "./Db";
import { GitHubGateway, PR_FILES_MAX_COUNT } from "./GitHub";
import type { GitHubEtagCache } from "./GitHubEtagCache";
import type { SettingsService } from "./Settings";

export interface CachedDiffFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
  readonly fetchedAt: string;
}

export class DiffCacheService extends Context.Tag("DiffCacheService")<
  DiffCacheService,
  {
    /** Returns cached files, or null on cache miss (no rows for this PR). */
    readonly getCachedFiles: (
      prId: string,
    ) => Effect.Effect<CachedDiffFile[] | null, never, DbService>;
    /** Atomically replace all cached files for a PR. */
    readonly cacheFiles: (
      prId: string,
      files: CachedDiffFile[],
    ) => Effect.Effect<void, never, DbService>;
    /** Delete all cached files for a PR. */
    readonly invalidateFiles: (prId: string) => Effect.Effect<void, never, DbService>;
    /** Delete all cached files for multiple PRs. */
    readonly invalidateFilesForPrs: (prIds: string[]) => Effect.Effect<void, never, DbService>;
    /** Return the set of PR IDs that have at least one cached diff row. */
    readonly getPrIdsWithCachedDiffs: () => Effect.Effect<string[], never, DbService>;
  }
>() {}

export const DiffCacheServiceLive = Layer.succeed(DiffCacheService, {
  getCachedFiles: (prId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = db.select().from(prDiffFiles).where(eq(prDiffFiles.prId, prId)).all();
      // null = cache miss (never fetched); treat no-rows as cache miss so re-fetch is safe
      if (rows.length === 0) return null;
      return rows.map((r) => ({
        path: r.path,
        oldPath: r.oldPath ?? null,
        status: r.status,
        additions: r.additions,
        deletions: r.deletions,
        patch: r.patch ?? null,
        fetchedAt: r.fetchedAt,
      }));
    }),

  cacheFiles: (prId, files) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.transaction(() => {
        db.delete(prDiffFiles).where(eq(prDiffFiles.prId, prId)).run();
        if (files.length > 0) {
          db.insert(prDiffFiles)
            .values(
              files.map((f) => ({
                id: `${prId}\0${f.path}`,
                prId,
                path: f.path,
                ...(f.oldPath !== null ? { oldPath: f.oldPath } : {}),
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                ...(f.patch !== null ? { patch: f.patch } : {}),
                fetchedAt: f.fetchedAt,
              })),
            )
            .run();
        }
      });
    }),

  invalidateFiles: (prId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.delete(prDiffFiles).where(eq(prDiffFiles.prId, prId)).run();
    }),

  invalidateFilesForPrs: (prIds) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (prIds.length === 0) return;
      db.delete(prDiffFiles).where(inArray(prDiffFiles.prId, prIds)).run();
    }),

  getPrIdsWithCachedDiffs: () =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = db.selectDistinct({ prId: prDiffFiles.prId }).from(prDiffFiles).all();
      return rows.map((r) => r.prId);
    }),
});

export function hasCompleteCachedFiles(
  cached: readonly CachedDiffFile[],
  expectedChangedFiles?: number,
): boolean {
  if (expectedChangedFiles === undefined) return true;
  return cached.length >= Math.min(expectedChangedFiles, PR_FILES_MAX_COUNT);
}

export function shouldServeCachedFilesOnFetchError(
  cached: readonly CachedDiffFile[] | null,
  error: GitHubError,
): cached is readonly CachedDiffFile[] {
  return cached !== null && error instanceof GitHubRateLimitError;
}

/**
 * Get diff files from cache, or fetch from GitHub on a cache miss.
 * Errors from GitHub propagate to the caller unless a rate limit happens
 * after we already have cached rows to render.
 */
export const getOrFetchDiffFiles = (
  prId: string,
  repoFullName: string,
  prExternalId: number,
  token: string,
  expectedChangedFiles?: number,
): Effect.Effect<
  CachedDiffFile[],
  GitHubError,
  DiffCacheService | GitHubGateway | DbService | GitHubEtagCache | SettingsService
> =>
  Effect.gen(function* () {
    const diffCache = yield* DiffCacheService;
    const github = yield* GitHubGateway;
    const { db } = yield* DbService;

    const cached = yield* withDb(db, diffCache.getCachedFiles(prId));
    if (cached !== null && hasCompleteCachedFiles(cached, expectedChangedFiles)) return cached;

    const fetched = yield* github.prs.files(repoFullName, prExternalId, token).pipe(
      Effect.map((fileList) => ({ source: "github" as const, fileList })),
      Effect.catchAll((err) => {
        if (shouldServeCachedFilesOnFetchError(cached, err)) {
          return Effect.succeed({ source: "cache" as const, files: cached });
        }
        return Effect.fail(err);
      }),
    );

    if (fetched.source === "cache") return [...fetched.files];

    const fileList = fetched.fileList;
    const files: CachedDiffFile[] = fileList.map((f) => ({
      path: f.filename,
      oldPath: f.previousFilename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
      fetchedAt: new Date().toISOString(),
    }));

    yield* withDb(db, diffCache.cacheFiles(prId, files));
    return files;
  });
