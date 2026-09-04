import { eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { prDiffFiles, pullRequests } from "../db/schema/index";
import { type GitHubError, GitHubRateLimitError } from "../domain/errors";
import { withDb } from "../effects/with-db";
import { DbService } from "./Db";
import { GitHubGateway, PR_FILES_MAX_COUNT, type PrFileMeta } from "./GitHub";
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
    /**
     * Atomically replace all cached files for a PR, and record the PR's diff
     * size from the same list.
     *
     * Callers must pass a *complete* file list from GitHub — every caller
     * currently does, straight out of `getPrFiles`. The PR's
     * additions/deletions/changed_files are derived here rather than by the
     * caller so the cached rows and the recorded size land in one transaction
     * and cannot drift apart.
     */
    readonly cacheFiles: (
      prId: string,
      files: CachedDiffFile[],
    ) => Effect.Effect<void, never, DbService>;
    /**
     * How many rows the last complete fetch stored for this PR, or null when
     * nothing has been cached since the column was introduced. See
     * `pullRequests.diffFilesCachedCount`.
     */
    readonly getCachedFileCount: (prId: string) => Effect.Effect<number | null, never, DbService>;
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
      // One row per path — the table is keyed on `(prId, path)`, so a repeated
      // path would collapse on write anyway. Collapsing here first (last entry
      // wins, matching the upsert) keeps the derived stats below counting each
      // stored row exactly once. `GitHubGateway.prs.files` already dedupes, but
      // this transaction owns the row-count invariant and must not depend on
      // its callers to uphold it.
      const rows = [...new Map(files.map((f) => [f.path, f])).values()];
      db.transaction((tx) => {
        tx.delete(prDiffFiles).where(eq(prDiffFiles.prId, prId)).run();
        if (rows.length > 0) {
          tx.insert(prDiffFiles)
            .values(
              rows.map((f) => ({
                id: `${prId}\0${f.path}`,
                prId,
                path: f.path,
                oldPath: f.oldPath,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                patch: f.patch,
                fetchedAt: f.fetchedAt,
              })),
            )
            .onConflictDoUpdate({
              target: prDiffFiles.id,
              set: {
                prId: sql`excluded.pr_id`,
                path: sql`excluded.path`,
                oldPath: sql`excluded.old_path`,
                status: sql`excluded.status`,
                additions: sql`excluded.additions`,
                deletions: sql`excluded.deletions`,
                patch: sql`excluded.patch`,
                fetchedAt: sql`excluded.fetched_at`,
              },
            })
            .run();

          // Record the PR's real diff size from the same fetch.
          //
          // This is the only place an *open* PR learns it: the poll reads
          // GitHub's list-PRs endpoint, which returns the "simple" PR object
          // with no additions/deletions/changed_files. Leaving `changed_files`
          // at 0 silently disables `hasCompleteCachedFiles` — it compares
          // against `min(expected, PR_FILES_MAX_COUNT)`, so a 0 expectation
          // accepts any cache, including a truncated one — and surfaces as
          // "+0 / -0" in AI prompts and recaps.
          let additions = 0;
          let deletions = 0;
          for (const f of rows) {
            additions += f.additions;
            deletions += f.deletions;
          }
          // `diffFilesCachedCount` records how many rows this write stored, so
          // `hasCompleteCachedFiles` has a signal that doesn't depend on
          // GitHub's `changed_files` stat agreeing with the number of distinct
          // paths it actually lists — for a PR containing a file whose type
          // changed, it never does. See the column's doc comment.
          tx.update(pullRequests)
            .set({
              additions,
              deletions,
              changedFiles: rows.length,
              diffFilesCachedCount: rows.length,
            })
            .where(eq(pullRequests.id, prId))
            .run();
        }
      });
    }),

  getCachedFileCount: (prId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select({ count: pullRequests.diffFilesCachedCount })
        .from(pullRequests)
        .where(eq(pullRequests.id, prId))
        .get();
      return row?.count ?? null;
    }),

  invalidateFiles: (prId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.transaction((tx) => {
        tx.delete(prDiffFiles).where(eq(prDiffFiles.prId, prId)).run();
        tx.update(pullRequests)
          .set({ diffFilesCachedCount: null })
          .where(eq(pullRequests.id, prId))
          .run();
      });
    }),

  invalidateFilesForPrs: (prIds) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (prIds.length === 0) return;
      db.transaction((tx) => {
        tx.delete(prDiffFiles).where(inArray(prDiffFiles.prId, prIds)).run();
        tx.update(pullRequests)
          .set({ diffFilesCachedCount: null })
          .where(inArray(pullRequests.id, prIds))
          .run();
      });
    }),

  getPrIdsWithCachedDiffs: () =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = db.selectDistinct({ prId: prDiffFiles.prId }).from(prDiffFiles).all();
      return rows.map((r) => r.prId);
    }),
});

/**
 * Decide whether the cached rows are the whole diff, or a partial cache that
 * has to be re-fetched.
 *
 * `cachedCount` — `pullRequests.diffFilesCachedCount`, written by `cacheFiles`
 * — is the authoritative signal and is checked first: if the cache still holds
 * every row the last fetch produced, it is complete by definition.
 *
 * `expectedChangedFiles` (GitHub's `changed_files`) is only the fallback, for
 * rows cached before that column existed. It is *not* reliable on its own:
 * GitHub counts file entries, and a path whose file type changed contributes
 * two of them (`removed` + `added`) while collapsing to one `pr_diff_files`
 * row. Treating that permanent gap as "cache incomplete" made a 3 000-file PR
 * re-fetch 30 pages of GitHub JSON — ~18 s — on every single page view.
 */
export function hasCompleteCachedFiles(
  cached: readonly CachedDiffFile[],
  expectedChangedFiles?: number,
  cachedCount?: number | null,
): boolean {
  if (cachedCount != null) return cached.length >= cachedCount;
  if (expectedChangedFiles === undefined) return true;
  return cached.length >= Math.min(expectedChangedFiles, PR_FILES_MAX_COUNT);
}

/**
 * Project GitHub's `files[]` shape onto the row shape the review surface
 * renders. Shared by the cached full-PR path and the ranged `?at=` compare
 * path so both produce byte-identical projections; `fetchedAt` is stamped even
 * on the ranged path, which never reaches `pr_diff_files` (its PK
 * `(prId, path)` has no range dimension), so the field stays non-optional.
 */
export function toCachedDiffFiles(files: readonly PrFileMeta[]): CachedDiffFile[] {
  const fetchedAt = new Date().toISOString();
  return files.map((f) => ({
    path: f.filename,
    oldPath: f.previousFilename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
    fetchedAt,
  }));
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
    if (cached !== null) {
      const cachedCount = yield* withDb(db, diffCache.getCachedFileCount(prId));
      if (hasCompleteCachedFiles(cached, expectedChangedFiles, cachedCount)) return cached;
    }

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

    const files = toCachedDiffFiles(fetched.fileList);

    yield* withDb(db, diffCache.cacheFiles(prId, files));
    return files;
  });
