import { Context, Effect, Layer } from 'effect';
import { eq } from 'drizzle-orm';
import { fileContentCache } from '../db/schema/index';
import { DbService } from './Db';
import { withDb } from '../effects/with-db';
import type { GitHubError } from '../domain/errors';
import { GitHubService } from './GitHub';

/**
 * Service for fetching file contents at a specific commit SHA.
 *
 * Content at a (repoFullName, path, ref) triple is immutable — commit SHAs
 * never change meaning — so cached entries never need invalidation.
 * Backed by the `file_content_cache` table; the primary key encodes the
 * triple separated by NUL bytes.
 */
export class FileContentService extends Context.Tag('FileContentService')<
	FileContentService,
	{
		/** Returns cached content or null on cache miss. */
		readonly getCached: (
			repoFullName: string,
			path: string,
			ref: string,
		) => Effect.Effect<string | null, never, DbService>;
		/** Store content at (repoFullName, path, ref). Idempotent (INSERT OR REPLACE). */
		readonly cache: (
			repoFullName: string,
			path: string,
			ref: string,
			content: string,
		) => Effect.Effect<void, never, DbService>;
		/** Read-through cache: returns cached content, or fetches from GitHub and caches it on miss. */
		readonly getOrFetch: (
			repoFullName: string,
			path: string,
			ref: string,
			token: string,
		) => Effect.Effect<string, GitHubError, DbService | GitHubService>;
		/** Stats for observability (hit/miss counters since process start). */
		readonly stats: () => { readonly hits: number; readonly misses: number };
	}
>() {}

/** Encode the composite primary key for the file_content_cache table. */
function makeKey(repoFullName: string, path: string, ref: string): string {
	return `${repoFullName}\0${path}\0${ref}`;
}

export const FileContentServiceLive = Layer.sync(FileContentService, () => {
	// In-memory counters; reset on process restart. Observability-only.
	let hits = 0;
	let misses = 0;

	const getCached = (repoFullName: string, path: string, ref: string) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const key = makeKey(repoFullName, path, ref);
			const row = db
				.select({ content: fileContentCache.content })
				.from(fileContentCache)
				.where(eq(fileContentCache.id, key))
				.get();
			return row ? row.content : null;
		});

	const cache = (
		repoFullName: string,
		path: string,
		ref: string,
		content: string,
	) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const key = makeKey(repoFullName, path, ref);
			const now = new Date().toISOString();
			db.insert(fileContentCache)
				.values({ id: key, content, fetchedAt: now })
				.onConflictDoUpdate({
					target: fileContentCache.id,
					set: { content, fetchedAt: now },
				})
				.run();
		});

	const getOrFetch = (
		repoFullName: string,
		path: string,
		ref: string,
		token: string,
	): Effect.Effect<string, GitHubError, DbService | GitHubService> =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const github = yield* GitHubService;

			const cached = yield* withDb(db, getCached(repoFullName, path, ref));
			if (cached !== null) {
				hits++;
				return cached;
			}

			misses++;
			const content = yield* github.getFileContent(repoFullName, path, ref, token);
			yield* withDb(db, cache(repoFullName, path, ref, content));
			return content;
		});

	return {
		getCached,
		cache,
		getOrFetch,
		stats: () => ({ hits, misses }),
	};
});
