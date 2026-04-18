import type { CacheRow, FetcherResult } from '../types';
import { buildPersist, isoNow, type Policy, type WriteDecision } from './Policy';

/**
 * ETag / If-None-Match freshness: the cache layer always revalidates with
 * upstream, but the row carries an ETag the fetcher can send back. Upstream
 * 304 responses produce a {@link FetcherResult} of `unchanged`, which bumps
 * `fetchedAt` without touching `valueJson`.
 *
 * Reads return `'stale'` when the TTL has elapsed (so the fetcher runs and
 * conditional-request the upstream); `'fresh'` otherwise. Set
 * `revalidateEveryMs: 0` to always revalidate on read.
 *
 * Writes persist the new ETag + Last-Modified on fresh responses.
 */
export class EtagPolicy implements Policy {
	readonly kind = 'etag';

	constructor(private readonly revalidateEveryMs: number) {}

	decideRead(row: CacheRow, now: number): 'fresh' | 'stale' | 'drop' {
		if (this.revalidateEveryMs === 0) return 'stale';
		const age = now - Date.parse(row.fetchedAt);
		return age <= this.revalidateEveryMs ? 'fresh' : 'stale';
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
				// 304 — refresh the fetch timestamp but keep the body + ETag intact.
				return { kind: 'touch', fetchedAt: isoNow(now), expiresAt: null };
			case 'fresh':
				return buildPersist({
					value: result.value,
					meta: result.meta,
					tag: null,
					// Hold until the caller decides to revalidate — no TTL expiry.
					ttlMs: null,
					now,
				});
		}
	}
}
