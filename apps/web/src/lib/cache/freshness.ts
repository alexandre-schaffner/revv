import type { CacheEntry, Freshness } from './types';

/**
 * Client-side freshness evaluation. Mirrors the policy decision tree on
 * the server but keeps the surface area small — just "is this fresh?".
 *
 * Returns:
 *   - `'fresh'` — serve cache, no network.
 *   - `'stale'` — serve cache now, refresh in background (SWR).
 *   - `'drop'`  — don't serve cached value at all; refetch.
 */
export type FreshnessDecision = 'fresh' | 'stale' | 'drop';

export function evaluateFreshness<T>(
	freshness: Freshness,
	entry: CacheEntry<T>,
	now: number = Date.now(),
): FreshnessDecision {
	switch (freshness.kind) {
		case 'immutable':
			return 'fresh';
		case 'ttl': {
			const age = now - entry.fetchedAt;
			return age <= freshness.ttlMs ? 'fresh' : 'stale';
		}
		case 'sha-keyed':
			if (!entry.sha) return 'drop';
			return entry.sha === freshness.sha ? 'fresh' : 'drop';
		case 'ws-driven':
			// Always fresh — the invalidation bus is the source of truth for
			// when this entry goes stale.
			return 'fresh';
	}
}

/** Small helpers for building Freshness instances ergonomically. */
export const TTL = (ms: number): Freshness => ({ kind: 'ttl', ttlMs: ms });
export const Immutable = (): Freshness => ({ kind: 'immutable' });
export const SHAKeyed = (sha: string): Freshness => ({ kind: 'sha-keyed', sha });
export const WsDriven = (namespace: string): Freshness => ({
	kind: 'ws-driven',
	namespace,
});
