import { memoryBackend, resolveBackend } from './backends';
import { evaluateFreshness, TTL } from './freshness';
import { queryRegistry, type RegisteredQuery } from './registry.svelte';
import { cacheStats } from './stats.svelte';
import type {
	Backend,
	CacheBackend,
	CacheEntry,
	FetchContext,
	FetcherMeta,
	Freshness,
	InvalidationReason,
	QueryStatus,
} from './types';

/**
 * `createQuery` — the client-side mirror of the server's `CacheLayer`.
 *
 * Each call constructs one reactive query handle that:
 *
 *   - Reads from a pluggable {@link CacheBackend} (memory in M1; IDB +
 *     layered in M3) and evaluates a {@link Freshness} policy on every load.
 *   - Runs the caller's `fetcher` on miss / stale / forced refresh, with
 *     module-level in-flight dedup so concurrent handles for the same key
 *     share a single network round-trip.
 *   - Registers with the module-singleton {@link queryRegistry} so the
 *     invalidation bus (M4) can flip it stale in response to WebSocket
 *     `cache:invalidated` messages.
 *   - Emits counters via {@link cacheStats} so Settings → Cache (M7) can
 *     surface hit rate, revalidations, offline serves.
 *
 * ### Lifecycle
 *
 * Creation kicks off an initial load unless `lazy` is set. The handle keeps
 * running until the caller invokes `dispose()`, which unregisters it,
 * aborts any in-flight fetch, and lets the registry GC the slot.
 *
 * ### SWR semantics
 *
 * Enabled by default for TTL policies. On a stale read the cached value is
 * served immediately (`status: 'stale'`) and a background fetch fires
 * (`status: 'revalidating'`) which settles to `'success'` or — if the
 * background request fails — leaves the cached value intact and surfaces
 * the error out-of-band while status returns to `'stale'`.
 *
 * ### Non-responsibilities
 *
 * - Does not coordinate across namespaces — that's the invalidation bus.
 * - Does not emit HTTP headers — that's `cache/http.ts` (M5).
 * - Does not manage the outbox — that's `lib/outbox/` (M6).
 */

/**
 * Options for {@link createQuery}. Only `key` and `fetcher` are required;
 * every other knob has an opinionated default (see inline comments).
 */
export interface QueryOptions<T> {
	/** Canonical cache key. Stable for a given logical query. */
	readonly key: string;
	/**
	 * Async data source. Receives a {@link FetchContext} carrying the prior
	 * cache entry's value and an `AbortSignal` scoped to the handle.
	 */
	readonly fetcher: (ctx: FetchContext) => Promise<T>;
	/** Freshness policy. Defaults to `TTL(60_000)`. */
	readonly freshness?: Freshness;
	/**
	 * Storage backend hint. Defaults to `'memory'`. In M1 every hint
	 * resolves to the in-memory singleton; M3 plugs in IDB + Layered.
	 */
	readonly backend?: Backend;
	/**
	 * Stale-while-revalidate. On a stale cache read, serve cached value
	 * immediately and refetch in the background. Defaults to `true` for
	 * TTL queries, `false` otherwise (Immutable / SHAKeyed / WsDriven).
	 */
	readonly swr?: boolean;
	/**
	 * Synchronous placeholder rendered before the first cache read resolves.
	 * Useful for suspense-free first paints (e.g. empty list skeletons).
	 */
	readonly placeholder?: () => T | undefined;
	/**
	 * Equality check for revalidated values — when it returns `true`, the
	 * handle skips reactive updates. Defaults to `Object.is`.
	 */
	readonly equalityFn?: (a: T, b: T) => boolean;
	/** Observer hook — fires whenever the handle is invalidated. */
	readonly onInvalidate?: (reason: InvalidationReason) => void;
	/** Skip the initial load; caller drives via `refresh()`. Defaults to `false`. */
	readonly lazy?: boolean;
}

/** Reactive handle returned by {@link createQuery}. */
export interface QueryHandle<T> {
	readonly key: string;
	readonly value: T | undefined;
	readonly status: QueryStatus;
	readonly error: Error | null;
	/** ISO-ms timestamp of the last successful cache write (from any source). */
	readonly fetchedAt: number | null;
	/** ISO-ms timestamp of the last reactive `value` change. */
	readonly updatedAt: number | null;
	/**
	 * Mark the handle stale. Triggers a background refresh when SWR applies,
	 * or a foreground refresh otherwise.
	 */
	invalidate(reason?: InvalidationReason): void;
	/**
	 * Force-fetch regardless of cache state. Resolves with the new value,
	 * rejects with the fetcher's error (or `Error('disposed')` if the
	 * handle is torn down mid-flight).
	 */
	refresh(): Promise<T>;
	/**
	 * Imperatively replace the value — used for optimistic updates and
	 * WebSocket-driven merges. Mirrors the write to the cache so other
	 * handles (and future loads) see it.
	 */
	setValue(next: T | ((prev: T | undefined) => T)): void;
	/** Release the handle — aborts in-flight fetches and drops the registry slot. */
	dispose(): void;
}

/**
 * Module-level in-flight Promise map. Keyed by cache key so that two
 * handles sharing `key` — or the same handle triggering overlapping
 * refreshes — collapse to one fetch. Reference-counted so the last
 * listener clears the slot.
 */
interface InflightRecord {
	readonly promise: Promise<unknown>;
	refs: number;
}
const inflight = new Map<string, InflightRecord>();

const DEFAULT_FRESHNESS: Freshness = TTL(60_000);

function namespaceOf(key: string): string {
	const idx = key.indexOf(':');
	return idx === -1 ? key : key.slice(0, idx);
}

function resolveBackendSafe(hint: Backend | undefined): CacheBackend {
	if (hint === undefined) return memoryBackend;
	return resolveBackend(hint);
}

function shouldUseSwr<T>(opts: QueryOptions<T>): boolean {
	if (opts.swr !== undefined) return opts.swr;
	const freshness = opts.freshness ?? DEFAULT_FRESHNESS;
	// Default: SWR on for TTL, off for Immutable / SHAKeyed / WsDriven —
	// those policies either never go stale implicitly or flip only via the
	// invalidation bus (WS-driven).
	return freshness.kind === 'ttl';
}

export function createQuery<T>(opts: QueryOptions<T>): QueryHandle<T> {
	const freshness = opts.freshness ?? DEFAULT_FRESHNESS;
	const backend = resolveBackendSafe(opts.backend);
	const swr = shouldUseSwr(opts);
	const equals: (a: T, b: T) => boolean = opts.equalityFn ?? Object.is;
	const ns = namespaceOf(opts.key);

	let value = $state<T | undefined>(opts.placeholder?.());
	let status = $state<QueryStatus>('idle');
	let error = $state<Error | null>(null);
	let fetchedAt = $state<number | null>(null);
	let updatedAt = $state<number | null>(null);

	/**
	 * Metadata the fetcher attached via `ctx.setMeta(...)`. Consumed by
	 * `writeCache` when the fetch settles. Cleared between runs.
	 */
	let pendingMeta: FetcherMeta | null = null;

	/** AbortController scoped to the handle. `dispose()` aborts it. */
	const handleAbort = new AbortController();
	let disposed = false;

	function commitValue(next: T, source: 'fetch' | 'manual'): void {
		const prev = value;
		const changed = prev === undefined || !equals(prev as T, next);
		if (changed) {
			value = next;
			updatedAt = Date.now();
		}
		if (source === 'fetch') fetchedAt = Date.now();
		error = null;
	}

	async function writeCache(next: T): Promise<void> {
		const meta = pendingMeta ?? {};
		// Build the entry conditionally — `exactOptionalPropertyTypes` rejects
		// `{ etag: undefined }`, so omit the field entirely when we have nothing.
		const entry: CacheEntry<T> = {
			value: next,
			fetchedAt: Date.now(),
			...(meta.sha !== undefined ? { sha: meta.sha } : {}),
			...(meta.etag !== undefined ? { etag: meta.etag } : {}),
			...(meta.lastModified !== undefined
				? { lastModified: meta.lastModified }
				: {}),
		};
		// SHA-keyed freshness: if the fetcher didn't stamp a SHA explicitly,
		// use the policy's SHA so subsequent reads compare correctly.
		const withSha =
			freshness.kind === 'sha-keyed' && entry.sha === undefined
				? { ...entry, sha: freshness.sha }
				: entry;
		try {
			await backend.write(opts.key, withSha);
		} catch {
			// Backend write failures are non-fatal at the primitive level —
			// M3's Layered backend handles quota / IDB fallback.
		}
	}

	async function readCache(): Promise<CacheEntry<T> | null> {
		try {
			return await backend.read<T>(opts.key);
		} catch {
			return null;
		}
	}

	function buildContext(prev: CacheEntry<T> | null): FetchContext {
		// Per-fetch AbortController tied to both the handle's lifetime and
		// the fetcher's own lifecycle. Disposing the handle aborts the fetch;
		// a subsequent refresh gets a fresh controller.
		const perFetch = new AbortController();
		if (handleAbort.signal.aborted) {
			perFetch.abort();
		} else {
			handleAbort.signal.addEventListener(
				'abort',
				() => perFetch.abort(),
				{ once: true },
			);
		}
		return {
			signal: perFetch.signal,
			previousValue: (prev?.value ?? null) as unknown,
			...(prev?.etag !== undefined ? { previousEtag: prev.etag } : {}),
			...(prev?.lastModified !== undefined
				? { previousLastModified: prev.lastModified }
				: {}),
			setMeta: (meta) => {
				pendingMeta = { ...(pendingMeta ?? {}), ...meta };
			},
		};
	}

	/**
	 * Run the fetcher through the inflight map. The first caller for a key
	 * becomes the "leader" and does the cache write; followers just await
	 * the shared Promise.
	 */
	async function runFetcher(prev: CacheEntry<T> | null): Promise<T> {
		const key = opts.key;
		const existing = inflight.get(key);
		if (existing) {
			cacheStats.recordInflightDedup();
			existing.refs++;
			try {
				return (await existing.promise) as T;
			} finally {
				existing.refs--;
				if (existing.refs === 0 && inflight.get(key) === existing) {
					inflight.delete(key);
				}
			}
		}

		const ctx = buildContext(prev);
		pendingMeta = null;
		const promise = (async () => {
			const result = await opts.fetcher(ctx);
			await writeCache(result);
			return result;
		})();

		const record: InflightRecord = { promise, refs: 1 };
		inflight.set(key, record);

		try {
			return (await promise) as T;
		} finally {
			record.refs--;
			if (record.refs === 0 && inflight.get(key) === record) {
				inflight.delete(key);
			}
		}
	}

	/**
	 * Read the cache, then — if needed — run the fetcher. Drives both the
	 * initial bootstrap and every subsequent invalidation / refresh.
	 *
	 * @param force  Skip cache consultation and go straight to the fetcher.
	 *               Used by `refresh()` and by the invalidation path when
	 *               SWR isn't applicable.
	 */
	async function load(force: boolean): Promise<T | undefined> {
		if (disposed) return undefined;

		if (!force) {
			const cached = await readCache();
			if (cached) {
				const decision = evaluateFreshness(freshness, cached);
				if (decision === 'fresh') {
					commitValue(cached.value, 'manual');
					fetchedAt = cached.fetchedAt;
					status = 'success';
					cacheStats.recordHit(opts.key);
					return cached.value;
				}
				if (decision === 'stale' && swr) {
					commitValue(cached.value, 'manual');
					fetchedAt = cached.fetchedAt;
					status = 'stale';
					cacheStats.recordStaleServe();
					cacheStats.recordHit(opts.key);
					// Background revalidate — errors stay out-of-band.
					void revalidate(cached);
					return cached.value;
				}
				if (decision === 'drop') {
					// Drop the stale row and fall through to a fresh fetch.
					try {
						await backend.remove(opts.key);
					} catch {
						// non-fatal
					}
				}
				// decision === 'stale' && !swr: fall through to foreground fetch,
				// but keep the cached value queued for the hint.
				return await fetchForeground(cached);
			}
		}

		return await fetchForeground(null);
	}

	async function fetchForeground(prev: CacheEntry<T> | null): Promise<T | undefined> {
		cacheStats.recordMiss(opts.key);
		status = value === undefined ? 'loading' : 'revalidating';
		try {
			const next = await runFetcher(prev);
			if (disposed) return undefined;
			commitValue(next, 'fetch');
			status = 'success';
			return next;
		} catch (err) {
			if (disposed) return undefined;
			const asError = err instanceof Error ? err : new Error(String(err));
			error = asError;
			cacheStats.recordError();
			// Offline heuristic — distinguish "no network" from "request failed"
			// so the UI can show different affordances.
			if (typeof navigator !== 'undefined' && navigator.onLine === false) {
				status = 'offline';
			} else {
				status = 'error';
			}
			throw asError;
		}
	}

	async function revalidate(prev: CacheEntry<T>): Promise<void> {
		if (disposed) return;
		status = 'revalidating';
		cacheStats.recordRevalidation();
		try {
			const next = await runFetcher(prev);
			if (disposed) return;
			commitValue(next, 'fetch');
			status = 'success';
		} catch (err) {
			if (disposed) return;
			// Background revalidation errors don't clobber the served-stale
			// value — keep `value` intact, surface the error, and fall back to
			// the `'stale'` status so the UI can retry.
			error = err instanceof Error ? err : new Error(String(err));
			cacheStats.recordError();
			status = 'stale';
		}
	}

	const registered: RegisteredQuery = {
		key: opts.key,
		namespace: ns,
		invalidate: (reason) => {
			opts.onInvalidate?.(reason);
			cacheStats.recordInvalidation();
			// If we have a value and SWR is on, hand the UI a stale marker and
			// refetch in the background. Otherwise force a foreground reload.
			if (value !== undefined && swr) {
				status = 'stale';
				void load(false);
			} else {
				void load(true);
			}
		},
		refresh: () => {
			void load(true);
		},
		dispose: () => {
			dispose();
		},
	};
	queryRegistry.register(registered);

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		handleAbort.abort();
		queryRegistry.unregister(registered);
	}

	const handle: QueryHandle<T> = {
		key: opts.key,
		get value() {
			return value;
		},
		get status() {
			return status;
		},
		get error() {
			return error;
		},
		get fetchedAt() {
			return fetchedAt;
		},
		get updatedAt() {
			return updatedAt;
		},
		invalidate(reason) {
			const r: InvalidationReason = reason ?? { source: 'manual' };
			registered.invalidate(r);
		},
		async refresh() {
			const result = await load(true);
			if (result === undefined) {
				// Either disposed mid-flight or the fetcher threw (which set
				// `error` already). Surface whichever is closest to the cause.
				throw error ?? new Error('Query disposed before refresh completed');
			}
			return result;
		},
		setValue(next) {
			const resolved =
				typeof next === 'function'
					? (next as (prev: T | undefined) => T)(value)
					: next;
			commitValue(resolved, 'manual');
			status = 'success';
			// Mirror the optimistic / imperative write into the cache so
			// reloads and other handles keyed the same see it.
			void writeCache(resolved);
		},
		dispose,
	};

	if (!opts.lazy) {
		// Fire-and-forget: the handle surfaces the outcome via its reactive
		// state; any throw from the initial load is already recorded as
		// `error` and reflected in `status`.
		void load(false).catch(() => {
			/* swallow — state already captured */
		});
	}

	return handle;
}
