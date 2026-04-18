/**
 * Shared types for the client-side cache primitive (`createQuery` v2).
 *
 * The client mirror of `apps/server/src/cache` is intentionally simpler:
 * there's no cross-scope dependency injection (everything is a module
 * singleton), no Effect graph, no per-namespace policy configuration.
 * The important shapes — freshness, backend, stats — are still pluggable
 * so M3 can drop in an IndexedDB backend without churning call sites.
 */

/** Status a query can be in. */
export type QueryStatus =
	| 'idle'
	| 'loading'
	| 'success'
	| 'stale'
	| 'revalidating'
	| 'error'
	| 'offline';

/**
 * Freshness policy variants. The client only needs four:
 *   - `TTL(ms)` — stale after a duration.
 *   - `Immutable` — stable forever; content-addressed keys.
 *   - `SHAKeyed(sha)` — fresh as long as the SHA we're asking for matches
 *     the SHA we stored (dropped otherwise).
 *   - `WsDriven(namespace)` — always fresh until the WebSocket tells us
 *     otherwise. Used for live-synced state (PR list, thread summaries).
 */
export type Freshness =
	| { readonly kind: 'ttl'; readonly ttlMs: number }
	| { readonly kind: 'immutable' }
	| { readonly kind: 'sha-keyed'; readonly sha: string }
	| { readonly kind: 'ws-driven'; readonly namespace: string };

/**
 * Backend label. The actual pluggable interface lives in
 * `cache/backends/index.ts`; this enum is what callers pass in as a hint.
 *
 * Call sites use it to signal intent ("this should persist to disk if we
 * have IDB"); the cache picks a real backend at runtime based on what's
 * available. In M1 everything resolves to Memory.
 */
export type Backend = 'memory' | 'idb' | 'layered' | 'local-storage';

/** Invalidation reason — purely for observability / breadcrumbs. */
export type InvalidationReason =
	| { readonly source: 'ws'; readonly message: string }
	| { readonly source: 'manual' }
	| { readonly source: 'ttl' }
	| { readonly source: 'sha-change'; readonly previousSha: string; readonly newSha: string }
	| { readonly source: 'namespace-bulk'; readonly namespace: string };

/** Backend interface — implemented by Memory today, IDB + Layered in M3. */
export interface CacheEntry<T> {
	readonly value: T;
	readonly fetchedAt: number;
	readonly sha?: string;
	readonly etag?: string;
	readonly lastModified?: string;
}

export interface CacheBackend {
	readonly kind: Backend;
	readonly read: <T>(key: string) => Promise<CacheEntry<T> | null>;
	readonly write: <T>(key: string, entry: CacheEntry<T>) => Promise<void>;
	readonly remove: (key: string) => Promise<void>;
	readonly removeByPrefix: (prefix: string) => Promise<void>;
	readonly keys: () => Promise<string[]>;
}

/** Fetch context — passed into fetchers so they can do conditional requests. */
export interface FetchContext {
	readonly signal: AbortSignal;
	/** Previously cached value, if any. */
	readonly previousValue: unknown;
	/** Prior ETag for conditional requests. */
	readonly previousEtag?: string;
	/** Prior Last-Modified for conditional requests. */
	readonly previousLastModified?: string;
}
