import type { CacheRow, FetcherResult } from '../types';
import {
	buildPersist,
	isoNow,
	readTag,
	type Policy,
	type WriteDecision,
} from './Policy';

/**
 * SHA-scoped freshness: like immutable, but the tag captures a specific
 * `(headSha, baseSha)` pair. Reads return 'drop' when the caller's expected
 * SHA doesn't match, forcing the cache layer to refetch for the new SHA.
 *
 * The policy itself is stateless — the caller supplies the expected SHA via
 * the write meta's `tag` field, and reads compare against the row's tag.
 *
 * Used for: `pr:diff-files`, GraphQL queries scoped to a PR's head commit.
 */
export interface ShaTag extends Record<string, unknown> {
	readonly headSha: string;
	readonly baseSha?: string;
}

export class ShaKeyedPolicy implements Policy {
	readonly kind = 'sha-keyed';

	constructor(
		/**
		 * Extract the expected SHA from the read-time context. In practice the
		 * cache layer passes `previousRow.tagJson` through a check to detect
		 * mismatches — this extractor exists so tests can swap in their own
		 * accessor.
		 */
		private readonly expected: () => ShaTag | null = () => null,
	) {}

	decideRead(row: CacheRow, _now: number): 'fresh' | 'stale' | 'drop' {
		const stored = readTag<ShaTag>(row.tagJson);
		const expected = this.expected();
		if (!stored) return 'drop';
		if (!expected) return 'fresh';
		if (stored.headSha !== expected.headSha) return 'drop';
		if (
			expected.baseSha !== undefined &&
			stored.baseSha !== undefined &&
			stored.baseSha !== expected.baseSha
		) {
			return 'drop';
		}
		return 'fresh';
	}

	decideWrite<V>(
		result: FetcherResult<V>,
		previous: CacheRow | null,
		now: number,
	): WriteDecision {
		switch (result.kind) {
			case 'invalid':
				return { kind: 'drop' };
			case 'unchanged':
				return { kind: 'touch', fetchedAt: isoNow(now), expiresAt: null };
			case 'fresh': {
				const shaTag = (result.meta?.tag ?? null) as ShaTag | null;
				return buildPersist({
					value: result.value,
					meta: result.meta,
					tag: shaTag,
					ttlMs: null,
					now,
				});
			}
		}
	}
}
