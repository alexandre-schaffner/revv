import type { CacheRow, FetcherResult } from '../types';
import { buildPersist, isoNow, type Policy, type WriteDecision } from './Policy';

/**
 * Content-addressed freshness: the key already encodes the content (e.g.
 * `repoFullName\0path\0ref`), so the row never goes stale by time. Writes
 * always persist with `expiresAt = null`.
 *
 * Reads always return 'fresh' while the row exists.
 *
 * Used for: `file:content` (keyed on ref), permanent metadata where the
 * caller is responsible for explicit invalidation.
 */
export class ImmutablePolicy implements Policy {
	readonly kind = 'immutable';

	decideRead(_row: CacheRow, _now: number): 'fresh' | 'stale' | 'drop' {
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
				// 304-style no-op on an immutable key just refreshes fetchedAt.
				return { kind: 'touch', fetchedAt: isoNow(now), expiresAt: null };
			case 'fresh':
				return buildPersist({
					value: result.value,
					meta: result.meta,
					tag: null,
					ttlMs: null,
					now,
				});
		}
	}
}
