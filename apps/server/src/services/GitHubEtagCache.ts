import { createHash } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { daysBefore, type RetentionPolicy } from "../db/retention";
import { githubEtagCache } from "../db/schema/index";
import { dbTry } from "../effects/db-try";
import { logError } from "../logger";
import { DbService } from "./Db";

/**
 * Rows here carry no expiry (an ETag stays valid indefinitely), and two things
 * grow the table fast: `listReviewComments` folds its advancing `since`
 * watermark into the key, leaving an unreachable row per move, and `listPrs`
 * stores the whole multi-page body. A week outlasts any live key's reuse (the
 * poll touches active keys every few minutes); reaping a live key costs one
 * unconditional refetch. `fetched_at` is stamped on 200 and left on 304, so a
 * key only replayed via 304s can be reaped too, which is the safe direction.
 */
export const etagCacheRetention: RetentionPolicy = {
  table: "github_etag_cache",
  sweep: (db, now) =>
    db
      .delete(githubEtagCache)
      .where(lt(githubEtagCache.fetchedAt, daysBefore(now, 7)))
      .returning({ key: githubEtagCache.cacheKey })
      .all().length,
};

/** Serialized-body shape stored in `github_etag_cache.body_json`. */
export interface CachedBody {
  readonly etag: string;
  readonly lastModified: string | null;
  readonly body: unknown;
}

export interface EtagStats {
  readonly hits304: number;
  readonly misses200: number;
  readonly bytesSaved: number;
}

/**
 * Build the cache key for a GitHub REST request. The query string is
 * canonicalized (alphabetical, dropped from the path) so `foo?a=1&b=2`
 * and `foo?b=2&a=1` collapse to the same key.
 */
export function buildCacheKey(method: string, pathWithQuery: string): string {
  const [rawPath, rawQuery = ""] = pathWithQuery.split("?", 2) as [string, string?];
  const params = new URLSearchParams(rawQuery);
  const sortedPairs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const sortedQuery = sortedPairs.map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = `${method.toUpperCase()} ${rawPath}${sortedQuery ? `?${sortedQuery}` : ""}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Conditional-request cache for GitHub REST bodies.
 *
 * Callers look up by cache key; on hit, they add `If-None-Match: <etag>`
 * to the outbound request. On a 304, the stored body is replayed — zero
 * bytes of real response data, zero rate-limit budget consumed.
 *
 * Backed by the `github_etag_cache` SQLite table + in-memory counters for
 * observability. Counters reset on process restart. A read or write that
 * fails costs one unconditional request, so failures are logged and
 * treated as a miss.
 */
export interface EtagCache {
  readonly get: (cacheKey: string) => Effect.Effect<CachedBody | null>;
  readonly put: (
    cacheKey: string,
    etag: string,
    lastModified: string | null,
    body: unknown,
  ) => Effect.Effect<void>;
  /** Call on a successful 304 so the hit counter + bytesSaved tally advance. */
  readonly recordHit: (bodyByteSize: number) => void;
  /** Call on a 200 so the miss counter advances. */
  readonly recordMiss: () => void;
  readonly stats: () => EtagStats;
}

export class GitHubEtagCache extends Context.Service<GitHubEtagCache, EtagCache>()(
  "GitHubEtagCache",
) {}

export const GitHubEtagCacheLive = Layer.effect(
  GitHubEtagCache,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    let hits304 = 0;
    let misses200 = 0;
    let bytesSaved = 0;

    const get = (cacheKey: string): Effect.Effect<CachedBody | null> =>
      dbTry("read GitHub ETag cache", () =>
        db
          .select({
            etag: githubEtagCache.etag,
            lastModified: githubEtagCache.lastModified,
            bodyJson: githubEtagCache.bodyJson,
          })
          .from(githubEtagCache)
          .where(eq(githubEtagCache.cacheKey, cacheKey))
          .get(),
      ).pipe(
        Effect.flatMap((row) =>
          row
            ? Effect.try(
                (): CachedBody => ({
                  etag: row.etag,
                  lastModified: row.lastModified ?? null,
                  body: JSON.parse(row.bodyJson) as unknown,
                }),
              )
            : Effect.succeed(null),
        ),
        Effect.catch((e) =>
          Effect.sync(() => {
            logError("GitHubEtagCache", "cache read failed:", e);
            return null;
          }),
        ),
      );

    const put = (cacheKey: string, etag: string, lastModified: string | null, body: unknown) =>
      dbTry("write GitHub ETag cache", () => {
        const now = new Date().toISOString();
        const bodyJson = JSON.stringify(body);
        db.insert(githubEtagCache)
          .values({ cacheKey, etag, lastModified, bodyJson, fetchedAt: now })
          .onConflictDoUpdate({
            target: githubEtagCache.cacheKey,
            set: { etag, lastModified, bodyJson, fetchedAt: now },
          })
          .run();
      }).pipe(Effect.catch((e) => Effect.sync(() => logError("GitHubEtagCache", e.message))));

    return {
      get,
      put,
      recordHit: (bodyByteSize: number) => {
        hits304++;
        bytesSaved += bodyByteSize;
      },
      recordMiss: () => {
        misses200++;
      },
      stats: () => ({ hits304, misses200, bytesSaved }),
    };
  }),
);
