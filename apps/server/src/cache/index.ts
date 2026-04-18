/**
 * Unified cache layer — server barrel.
 *
 * See `apps/server/src/cache/CacheLayer.ts` for the design overview.
 */

export {
	type CacheLayer,
	CacheMiss,
	makeCacheLayer,
	type MakeCacheLayerOptions,
} from './CacheLayer';
export { type StorageBackend } from './Storage';
export {
	type Keyer,
	stringKey,
	tupleKey,
	hashKey,
	makeTupleKeyer,
	makeHashKeyer,
} from './Key';
export { CacheStats, CacheStatsLive, type NamespaceRegistration } from './Stats';
export {
	InvalidationBus,
	InvalidationBusLive,
	type InvalidationEvent,
	type RecentEvent,
	type InvalidationBusService,
} from './InvalidationBus';
export type {
	CacheRow,
	CacheCounters,
	CacheNamespaceStats,
	FetcherResult,
	RevalidationHint,
	PolicyWriteMeta,
} from './types';
export * from './backends/index';
export * from './policies/index';
