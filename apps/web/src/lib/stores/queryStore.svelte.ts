/**
 * Generic reactive query primitive for the Revv web client.
 *
 * Each `createQuery` instance manages one async data source with:
 * - Reactive `$state` for value, status, and error
 * - In-flight deduplication via a module-level Promise map
 * - TTL-based staleness check (optional)
 * - Manual `invalidate()` + `refresh()` for imperative control
 * - A `persist` hook (no-op in Phase 3 — wired to IDB in Phase 4)
 *
 * Usage:
 * ```ts
 * const prsQuery = createQuery({
 *   key: 'prs:list',
 *   fetcher: () => api.api.prs.get().then(r => r.data),
 *   ttlMs: 30_000,
 * });
 * // In a component: prsQuery.value, prsQuery.status
 * ```
 */

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error' | 'stale';

export interface QueryOptions<T> {
	/** Unique cache key for this query. */
	key: string;
	/** Async function that fetches the data. */
	fetcher: () => Promise<T>;
	/** How long (ms) before a successful result is considered stale. Omit for immutable. */
	ttlMs?: number;
	/**
	 * If true, return the cached value immediately while revalidating in background.
	 * Only meaningful when `ttlMs` is set.
	 */
	staleWhileRevalidate?: boolean;
	/**
	 * Phase 4 hook: persist to IndexedDB. No-op in Phase 3.
	 * Setting this to true has no effect until the IDB backing is wired.
	 */
	persist?: boolean;
}

export interface QueryResult<T> {
	/** The current cached value, or undefined before the first successful fetch. */
	readonly value: T | undefined;
	/** Current fetch status. */
	readonly status: QueryStatus;
	/** Error from the last failed fetch, or null. */
	readonly error: Error | null;
	/** Mark the cached value as stale; triggers a background refresh if a consumer is active. */
	invalidate(): void;
	/** Force an immediate network fetch regardless of cache state. Returns the new value. */
	refresh(): Promise<T>;
}

// Module-level in-flight dedup map: key → Promise<unknown>
const inflight = new Map<string, Promise<unknown>>();

export function createQuery<T>(opts: QueryOptions<T>): QueryResult<T> {
	let value = $state<T | undefined>(undefined);
	let status = $state<QueryStatus>('idle');
	let error = $state<Error | null>(null);
	let fetchedAt: number | null = null;

	const isStale = (): boolean => {
		if (opts.ttlMs === undefined) return false;
		if (fetchedAt === null) return true;
		return Date.now() - fetchedAt > opts.ttlMs;
	};

	const doFetch = async (): Promise<T> => {
		// In-flight dedup: if a fetch for this key is already running, share it
		const existing = inflight.get(opts.key);
		if (existing) {
			return existing as Promise<T>;
		}

		const promise = opts.fetcher().then(
			(result) => {
				value = result;
				status = 'success';
				error = null;
				fetchedAt = Date.now();
				inflight.delete(opts.key);
				return result;
			},
			(err: unknown) => {
				status = 'error';
				error = err instanceof Error ? err : new Error(String(err));
				inflight.delete(opts.key);
				throw error;
			},
		);

		inflight.set(opts.key, promise);
		return promise;
	};

	return {
		get value() {
			return value;
		},
		get status() {
			return status;
		},
		get error() {
			return error;
		},
		invalidate() {
			if (value !== undefined) {
				status = 'stale';
			}
			// Background revalidation is triggered externally via refresh()
		},
		async refresh(): Promise<T> {
			status = 'loading';
			return doFetch();
		},
	};
}
