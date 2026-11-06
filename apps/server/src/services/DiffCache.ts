import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Db } from "../db/index";
import { prDiffFiles, pullRequests } from "../db/schema/index";
import { type DbError, type GitHubError, GitHubRateLimitError } from "../domain/errors";
import { dbTry } from "../effects/db-try";
import { DbService } from "./Db";
import { GitHubGateway } from "./github/gateway";
import { PR_FILES_MAX_COUNT, type PrFileMeta } from "./github/pulls";
import type { GitHubClient } from "./github/transport";
import { Realtime } from "./Realtime";

export interface CachedDiffFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
  readonly fetchedAt: string;
}

/** A PR as its row stood when a files fetch started. */
export type FetchedFor = Pick<typeof pullRequests.$inferSelect, "id" | "headSha" | "baseSha">;

const filesAreCurrent = and(
  eq(pullRequests.diffFilesHeadSha, pullRequests.headSha),
  sql`${pullRequests.diffFilesBaseSha} is ${pullRequests.baseSha}`,
);

const prsWithCurrentFiles = (db: Db) =>
  db.select({ id: pullRequests.id }).from(pullRequests).where(filesAreCurrent);

/**
 * Cached files per PR id, in stored order. A PR absent from the map has
 * nothing cached for its current head and base; one mapped to `[]` has a
 * cached empty diff.
 */
export function readCurrentHeadFiles(
  db: Db,
  prIds: readonly string[],
): ReadonlyMap<string, CachedDiffFile[]> {
  const byPr = new Map<string, CachedDiffFile[]>();
  if (prIds.length === 0) return byPr;
  const current = db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(and(inArray(pullRequests.id, [...prIds]), filesAreCurrent))
    .all();
  for (const { id } of current) byPr.set(id, []);
  if (byPr.size === 0) return byPr;
  for (const r of db
    .select()
    .from(prDiffFiles)
    .where(inArray(prDiffFiles.prId, [...byPr.keys()]))
    .all()) {
    byPr.get(r.prId)?.push({
      path: r.path,
      oldPath: r.oldPath ?? null,
      status: r.status,
      additions: r.additions,
      deletions: r.deletions,
      patch: r.patch ?? null,
      fetchedAt: r.fetchedAt,
    });
  }
  return byPr;
}

/** One file's cached patch for the PR's current head and base, or null when none is cached. */
export function readCurrentHeadPatch(db: Db, prId: string, path: string): string | null {
  const row = db
    .select({ patch: prDiffFiles.patch })
    .from(prDiffFiles)
    .where(
      and(
        eq(prDiffFiles.prId, prId),
        eq(prDiffFiles.path, path),
        inArray(prDiffFiles.prId, prsWithCurrentFiles(db)),
      ),
    )
    .get();
  return row?.patch ?? null;
}

/** GitHub's `files[]` entries in the cached row shape: the one projection between the two. */
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

/**
 * Cached rows in GitHub's `files[]` field names, for consumers written against
 * GitHub's shape (the agents' diff readers, stack fingerprints).
 */
export function toGitHubFileShape(files: readonly CachedDiffFile[]): Array<{
  readonly filename: string;
  readonly previousFilename: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
}> {
  return files.map((f) => ({
    filename: f.path,
    previousFilename: f.oldPath,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
}

/**
 * Whether the cached rows are the whole diff, or a partial cache that has to
 * be re-fetched.
 *
 * `cachedCount` — `pullRequests.diffFilesCachedCount`, written with the rows —
 * is checked first: if the cache still holds every row the last fetch
 * produced, it is complete by definition.
 *
 * `expectedChangedFiles` (GitHub's `changed_files`) is only the fallback, for
 * rows cached before that column existed. It is not reliable on its own:
 * GitHub counts file entries, and a path whose file type changed contributes
 * two of them (`removed` + `added`) while collapsing to one row. Treating that
 * permanent gap as "incomplete" made a 3 000-file PR re-fetch 30 pages of
 * GitHub JSON — ~18 s — on every page view.
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

/** A rate limit with a cache in hand serves the cache: the diff, if maybe not the newest. */
export function shouldServeCachedFilesOnFetchError(
  cached: readonly CachedDiffFile[] | null,
  error: GitHubError,
): cached is readonly CachedDiffFile[] {
  return cached !== null && error instanceof GitHubRateLimitError;
}

export class DiffCacheService extends Context.Service<
  DiffCacheService,
  {
    /**
     * A PR's diff files: the cache when it is complete for the PR's current
     * head and base, otherwise GitHub's list, written through (and announced
     * as `diff:cached`). `source` says which answered.
     */
    readonly getOrFetch: (
      pr: { readonly id: string; readonly externalId: number },
      repoFullName: string,
      client: GitHubClient,
    ) => Effect.Effect<
      { readonly files: CachedDiffFile[]; readonly source: "cache" | "github" },
      GitHubError | DbError
    >;
    /** The files cached for the PR's current head and base (`[]` for an empty diff), or null. */
    readonly getCachedFiles: (prId: string) => Effect.Effect<CachedDiffFile[] | null, DbError>;
    /** The PRs with files cached for their current head and base. */
    readonly getPrIdsWithCachedDiffs: () => Effect.Effect<string[], DbError>;
  }
>()("DiffCacheService") {}

export const DiffCacheServiceLive = Layer.effect(
  DiffCacheService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const github = yield* GitHubGateway;
    const realtime = yield* Realtime;

    const getCachedFiles = (prId: string) =>
      dbTry("read cached diff", () => readCurrentHeadFiles(db, [prId]).get(prId) ?? null);

    /**
     * Replace a PR's cached files and record its diff size from the same list,
     * in one transaction; then tell the PR's clients the diff is in.
     *
     * The size is derived here because this is the only place an open PR
     * learns it: the poll's list endpoint carries no additions/deletions/
     * changed_files.
     *
     * `fetchedFor` is the PR row as read before the fetch started. The files
     * read as the PR's diff only while its head and base are still that row's,
     * so a fetch that raced a head move is refetched, never served.
     */
    const cacheFiles = (fetchedFor: FetchedFor, files: readonly CachedDiffFile[]) =>
      Effect.gen(function* () {
        const prId = fetchedFor.id;
        // Keyed on `(prId, path)`: collapse repeats (last wins) so the size
        // counts stored rows.
        const rows = [...new Map(files.map((f) => [f.path, f])).values()];
        let additions = 0;
        let deletions = 0;
        for (const f of rows) {
          additions += f.additions;
          deletions += f.deletions;
        }
        yield* dbTry("cache diff files", () =>
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
                .run();
            }
            // `diffFilesCachedCount` is what completeness trusts: GitHub's
            // `changed_files` disagrees with the distinct paths it lists
            // whenever a file's type changed.
            tx.update(pullRequests)
              .set({
                additions,
                deletions,
                changedFiles: rows.length,
                diffFilesCachedCount: rows.length,
                diffFilesHeadSha: fetchedFor.headSha,
                diffFilesBaseSha: fetchedFor.baseSha,
              })
              .where(eq(pullRequests.id, prId))
              .run();
          }),
        );
        if (fetchedFor.headSha !== null) {
          yield* realtime.toPr(prId, {
            type: "diff:cached",
            data: { prId, headSha: fetchedFor.headSha },
          });
        }
      });

    const getOrFetch = (
      pr: { readonly id: string; readonly externalId: number },
      repoFullName: string,
      client: GitHubClient,
    ) =>
      Effect.gen(function* () {
        const stored = yield* dbTry("read diff watermark", () =>
          db
            .select({
              headSha: pullRequests.headSha,
              baseSha: pullRequests.baseSha,
              changedFiles: pullRequests.changedFiles,
              cachedCount: pullRequests.diffFilesCachedCount,
            })
            .from(pullRequests)
            .where(eq(pullRequests.id, pr.id))
            .get(),
        );
        const cached = yield* getCachedFiles(pr.id);
        if (
          cached !== null &&
          hasCompleteCachedFiles(cached, stored?.changedFiles, stored?.cachedCount)
        ) {
          return { files: cached, source: "cache" as const };
        }

        const fetched = yield* github.prs.files(client, repoFullName, pr.externalId).pipe(
          Effect.map((list) => ({ files: toCachedDiffFiles(list), source: "github" as const })),
          Effect.catch((err) =>
            shouldServeCachedFilesOnFetchError(cached, err)
              ? Effect.succeed({ files: [...cached], source: "cache" as const })
              : Effect.fail(err),
          ),
        );
        if (fetched.source === "github") {
          yield* cacheFiles(
            { id: pr.id, headSha: stored?.headSha ?? null, baseSha: stored?.baseSha ?? null },
            fetched.files,
          );
        }
        return fetched;
      });

    return {
      getOrFetch,
      getCachedFiles,
      getPrIdsWithCachedDiffs: () =>
        dbTry("list PRs with cached diffs", () =>
          prsWithCurrentFiles(db)
            .all()
            .map((r) => r.id),
        ),
    };
  }),
);
