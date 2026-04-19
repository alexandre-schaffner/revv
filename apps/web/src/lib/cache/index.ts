/**
 * Public surface for the client-side cache layer.
 *
 * Consumers should import exclusively from `$lib/cache` — the internal
 * module layout (`createQuery.svelte.ts`, `registry.svelte.ts`, backends,
 * freshness, stats, types) is an implementation detail that may shift as
 * M3 (IndexedDB) and M4 (invalidation bus) land.
 */

export { createQuery } from './createQuery.svelte';
export type { QueryHandle, QueryOptions } from './createQuery.svelte';

export { queryRegistry } from './registry.svelte';
export type { RegisteredQuery } from './registry.svelte';

export { evaluateFreshness, Immutable, SHAKeyed, TTL, WsDriven } from './freshness';
export type { FreshnessDecision } from './freshness';

export { cacheStats } from './stats.svelte';
export type { CacheStatsSnapshot } from './stats.svelte';

export { createMemoryBackend, memoryBackend, resolveBackend } from './backends';

export type {
	Backend,
	CacheBackend,
	CacheEntry,
	FetchContext,
	FetcherMeta,
	Freshness,
	InvalidationReason,
	QueryStatus,
} from './types';
