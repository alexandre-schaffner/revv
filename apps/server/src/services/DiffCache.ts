import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Db } from "../db/index";
import { prDiffFiles, pullRequests } from "../db/schema/index";
import type { DbError, GitHubError } from "../domain/errors";
import { dbTry } from "../effects/db-try";
import { DbService } from "./Db";
import { GitHubGateway } from "./github/gateway";
import type { PrCommit, PrFileMeta } from "./github/pulls";
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

/** A PR's cached diff: its files and its commits (head first) for one range. */
export interface CachedDiff {
  readonly files: CachedDiffFile[];
  readonly commits: PrCommit[];
}

/**
 * The PR's cached diff for its current head and base, or null when its files
 * or its commits aren't cached for them.
 */
export function readCurrentHeadDiff(db: Db, prId: string): CachedDiff | null {
  const files = readCurrentHeadFiles(db, [prId]).get(prId);
  if (files === undefined) return null;
  const row = db
    .select({ commits: pullRequests.diffCommits })
    .from(pullRequests)
    .where(eq(pullRequests.id, prId))
    .get();
  if (row?.commits == null) return null;
  const commits: PrCommit[] = JSON.parse(row.commits);
  return { files, commits };
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

export class DiffCacheService extends Context.Service<
  DiffCacheService,
  {
    /**
     * A PR's diff: the cache when it holds the PR's current head and base,
     * otherwise GitHub's files and commits, written through (and announced
     * as `diff:cached`). `source` says which answered.
     */
    readonly getOrFetch: (
      pr: { readonly id: string; readonly externalId: number },
      repoFullName: string,
      client: GitHubClient,
    ) => Effect.Effect<CachedDiff & { readonly source: "cache" | "github" }, GitHubError | DbError>;
    /** The files cached for the PR's current head and base (`[]` for an empty diff), or null. */
    readonly getCachedFiles: (prId: string) => Effect.Effect<CachedDiffFile[] | null, DbError>;
    /** The diff cached for the PR's current head and base, or null. */
    readonly getCachedDiff: (prId: string) => Effect.Effect<CachedDiff | null, DbError>;
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
      dbTry("read cached diff files", () => readCurrentHeadFiles(db, [prId]).get(prId) ?? null);

    const getCachedDiff = (prId: string) =>
      dbTry("read cached diff", () => readCurrentHeadDiff(db, prId));

    /**
     * Replace a PR's cached diff and record its size from the same file list,
     * in one transaction; then tell the PR's clients the diff is in.
     *
     * `fetchedFor` is the PR row as read before the fetch started. The files
     * read as the PR's diff only while its head and base are still that row's,
     * so a fetch that raced a head move is refetched, never served.
     */
    const cacheDiff = (fetchedFor: FetchedFor, { files, commits }: CachedDiff) =>
      Effect.gen(function* () {
        const prId = fetchedFor.id;
        // GitHub lists a type-changed path twice; rows are keyed on
        // `(prId, path)`, so keep the last and count stored rows.
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
            tx.update(pullRequests)
              .set({
                additions,
                deletions,
                changedFiles: rows.length,
                diffFilesHeadSha: fetchedFor.headSha,
                diffFilesBaseSha: fetchedFor.baseSha,
                diffCommits: JSON.stringify(commits),
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
            })
            .from(pullRequests)
            .where(eq(pullRequests.id, pr.id))
            .get(),
        );
        const cached = yield* getCachedDiff(pr.id);
        if (cached !== null) return { ...cached, source: "cache" as const };

        const diff: CachedDiff = {
          files: toCachedDiffFiles(yield* github.prs.files(client, repoFullName, pr.externalId)),
          commits: yield* github.prs.commits(client, repoFullName, pr.externalId),
        };
        yield* cacheDiff(
          { id: pr.id, headSha: stored?.headSha ?? null, baseSha: stored?.baseSha ?? null },
          diff,
        );
        return { ...diff, source: "github" as const };
      });

    return {
      getOrFetch,
      getCachedFiles,
      getCachedDiff,
      getPrIdsWithCachedDiffs: () =>
        dbTry("list PRs with cached diffs", () =>
          prsWithCurrentFiles(db)
            .all()
            .map((r) => r.id),
        ),
    };
  }),
);
