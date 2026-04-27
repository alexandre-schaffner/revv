/**
 * Unified cache layer — server barrel.
 *
 * See `apps/server/src/cache/CacheLayer.ts` for the design overview.
 */

export * from "./backends/index";
export {
  type CacheLayer,
  CacheMiss,
  type MakeCacheLayerOptions,
  makeCacheLayer,
} from "./CacheLayer";
export {
  InvalidationBus,
  InvalidationBusLive,
  type InvalidationBusService,
  type InvalidationEvent,
  type RecentEvent,
} from "./InvalidationBus";
export {
  hashKey,
  type Keyer,
  makeHashKeyer,
  makeTupleKeyer,
  stringKey,
  tupleKey,
} from "./Key";
export * from "./policies/index";
export {
  CacheStats,
  CacheStatsLive,
  type NamespaceRegistration,
} from "./Stats";
export type { StorageBackend } from "./Storage";
export type {
  CacheCounters,
  CacheNamespaceStats,
  CacheRow,
  FetcherResult,
  PolicyWriteMeta,
  RevalidationHint,
} from "./types";
