import { createHash } from 'node:crypto';
import { Context, Effect, Layer } from 'effect';
import { eq } from 'drizzle-orm';
import { githubEtagCache } from '../db/schema/index';
import { DbService } from './Db';

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
	const [rawPath, rawQuery = ''] = pathWithQuery.split('?', 2) as [string, string?];
	const params = new URLSearchParams(rawQuery);
	const sortedPairs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
	const sortedQuery = sortedPairs.map(([k, v]) => `${k}=${v}`).join('&');
	const canonical = `${method.toUpperCase()} ${rawPath}${sortedQuery ? '?' + sortedQuery : ''}`;
	return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Conditional-request cache for GitHub REST bodies.
 *
 * Callers look up by cache key; on hit, they add `If-None-Match: <etag>`
 * to the outbound request. On a 304, the stored body is replayed — zero
 * bytes of real response data, zero rate-limit budget consumed.
 *
 * Backed by the `github_etag_cache` SQLite table + in-memory counters for
 * observability. Counters reset on process restart.
 */
export class GitHubEtagCache extends Context.Tag('GitHubEtagCache')<
	GitHubEtagCache,
	{
		readonly get: (
			cacheKey: string,
		) => Effect.Effect<CachedBody | null, never, DbService>;
		readonly put: (
			cacheKey: string,
			etag: string,
			lastModified: string | null,
			body: unknown,
		) => Effect.Effect<void, never, DbService>;
		/** Call on a successful 304 so the hit counter + bytesSaved tally advance. */
		readonly recordHit: (bodyByteSize: number) => void;
		/** Call on a 200 so the miss counter advances. */
		readonly recordMiss: () => void;
		readonly stats: () => EtagStats;
	}
>() {}

export const GitHubEtagCacheLive = Layer.sync(GitHubEtagCache, () => {
	let hits304 = 0;
	let misses200 = 0;
	let bytesSaved = 0;

	const get = (cacheKey: string) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const row = db
				.select({
					etag: githubEtagCache.etag,
					lastModified: githubEtagCache.lastModified,
					bodyJson: githubEtagCache.bodyJson,
				})
				.from(githubEtagCache)
				.where(eq(githubEtagCache.cacheKey, cacheKey))
				.get();
			if (!row) return null;
			try {
				const body = JSON.parse(row.bodyJson) as unknown;
				return {
					etag: row.etag,
					lastModified: row.lastModified ?? null,
					body,
				} satisfies CachedBody;
			} catch {
				// Corrupt JSON — treat as a miss so the next call overwrites.
				return null;
			}
		});

	const put = (
		cacheKey: string,
		etag: string,
		lastModified: string | null,
		body: unknown,
	) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const now = new Date().toISOString();
			const bodyJson = JSON.stringify(body);
			db.insert(githubEtagCache)
				.values({
					cacheKey,
					etag,
					lastModified,
					bodyJson,
					fetchedAt: now,
				})
				.onConflictDoUpdate({
					target: githubEtagCache.cacheKey,
					set: { etag, lastModified, bodyJson, fetchedAt: now },
				})
				.run();
		});

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
});
