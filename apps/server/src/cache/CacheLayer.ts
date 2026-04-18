import { Effect, Runtime } from 'effect';
import type { DbService } from '../services/Db';
import type { Keyer } from './Key';
import type { Policy } from './policies/index';
import type { StorageBackend } from './Storage';
import type { CacheStats, NamespaceRegistration } from './Stats';
import type {
	CacheCounters,
	CacheRow,
	FetcherResult,
	RevalidationHint,
} from './types';

/**
 * Caller-facing cache abstraction — one instance per namespace.
 *
 * ### Responsibilities
 *
 * - Serialize caller keys via {@link Keyer}, stamp with `namespace`.
 * - Run {@link Policy.decideRead} on every `get`, route stale/drop
 *   accordingly.
 * - Run {@link Policy.decideWrite} on every fetcher result, persist via
 *   the backend.
 * - Maintain in-flight dedup so concurrent `getOrFetch` calls for the same
 *   key share a single Promise.
 * - Emit counters via the shared {@link CacheStats} service.
 *
 * ### Not responsible for
 *
 * - Cross-namespace invalidation (use {@link InvalidationBus}).
 * - WebSocket fan-out (handled by the bus subscribers).
 * - HTTP response headers (see `routes/etag.ts`).
 */
export interface CacheLayer<K, V> {
	readonly namespace: string;
	readonly get: (k: K) => Effect.Effect<V | null, never, DbService>;
	readonly set: (
		k: K,
		v: V,
		meta?: {
			etag?: string;
			lastModified?: string;
			tag?: Record<string, unknown>;
			ttlMs?: number | null;
		},
	) => Effect.Effect<void, never, DbService>;
	readonly getOrFetch: <E, R>(
		k: K,
		fetcher: (hint: RevalidationHint<V>) => Effect.Effect<FetcherResult<V>, E, R>,
	) => Effect.Effect<V, E | CacheMiss, R | DbService>;
	readonly invalidate: (k: K, reason: string) => Effect.Effect<void, never, DbService>;
	readonly invalidatePrefix: (
		keyPrefix: string,
		reason: string,
	) => Effect.Effect<void, never, DbService>;
	readonly invalidateAll: (reason: string) => Effect.Effect<void, never, DbService>;
	readonly counters: CacheCounters;
}

/**
 * Surfaced when `getOrFetch`'s fetcher returns `invalid` (upstream 404) and
 * no cached value is available — the caller can't be satisfied. Rare, but
 * fatal for the specific call.
 */
export class CacheMiss {
	readonly _tag = 'CacheMiss';
	constructor(readonly namespace: string, readonly key: string) {}
}

export interface MakeCacheLayerOptions<K, V> {
	readonly namespace: string;
	readonly backend: StorageBackend;
	readonly policy: Policy;
	readonly keyer: Keyer<K>;
	/** Stats service instance to register counters with. */
	readonly stats: Effect.Effect.Success<typeof CacheStats>;
	/**
	 * Parse a raw JSON string back into `V`. Defaults to `JSON.parse`.
	 * Namespaces with strongly-typed shapes can swap in a validator here.
	 */
	readonly parse?: (json: string) => V;
}

export function makeCacheLayer<K, V>(
	opts: MakeCacheLayerOptions<K, V>,
): Effect.Effect<CacheLayer<K, V>, never> {
	return Effect.gen(function* () {
		const { namespace, backend, policy, keyer, stats, parse } = opts;
		const doParse: (json: string) => V =
			parse ?? ((json) => JSON.parse(json) as V);

		// Shared counters — stats.register holds the pointer, we increment
		// on the hot path.
		const counters: CacheCounters = {
			hits: 0,
			misses: 0,
			revalidatedUnchanged: 0,
			inflightDedups: 0,
			bytesSaved: 0,
		};

		const registration: NamespaceRegistration = {
			namespace,
			policyKind: policy.kind,
			backend,
			counters,
		};
		yield* stats.register(registration);

		// In-flight dedup: one Promise per `(ns, key)` string, shared across
		// concurrent callers so the fetcher runs exactly once.
		const inflight = new Map<string, Promise<V>>();
		const fullKey = (k: string) => `${namespace}\0${k}`;

		const tryParse = (json: string): V | null => {
			try {
				return doParse(json);
			} catch {
				return null;
			}
		};

		const get = (k: K): Effect.Effect<V | null, never, DbService> =>
			Effect.gen(function* () {
				const key = keyer(k);
				const row = yield* backend.readOne(namespace, key);
				if (!row) {
					counters.misses++;
					return null;
				}
				const decision = policy.decideRead(row, Date.now());
				if (decision === 'drop') {
					yield* backend.deleteOne(namespace, key);
					counters.misses++;
					return null;
				}
				if (decision === 'stale') {
					// Plain `get` surfaces stale as miss — SWR lives in getOrFetch.
					counters.misses++;
					return null;
				}
				const parsed = tryParse(row.valueJson);
				if (parsed === null) {
					// Corrupt JSON → drop + miss so next write overwrites.
					yield* backend.deleteOne(namespace, key);
					counters.misses++;
					return null;
				}
				counters.hits++;
				return parsed;
			});

		const set = (
			k: K,
			v: V,
			meta?: {
				etag?: string;
				lastModified?: string;
				tag?: Record<string, unknown>;
				ttlMs?: number | null;
			},
		): Effect.Effect<void, never, DbService> =>
			Effect.gen(function* () {
				const key = keyer(k);
				// `exactOptionalPropertyTypes` rejects `{ meta: undefined }`, so build
				// the result conditionally instead of spreading maybe-undefined.
				const freshResult: FetcherResult<V> =
					meta === undefined
						? { kind: 'fresh', value: v }
						: { kind: 'fresh', value: v, meta };
				const decision = policy.decideWrite<V>(
					freshResult,
					null,
					Date.now(),
				);
				if (decision.kind === 'drop') {
					yield* backend.deleteOne(namespace, key);
					return;
				}
				if (decision.kind === 'touch') {
					// Caller shouldn't produce a touch from `set` — defensive return.
					return;
				}
				const row: CacheRow = {
					ns: namespace,
					key,
					valueJson: decision.valueJson,
					etag: decision.etag,
					lastModified: decision.lastModified,
					tagJson: decision.tagJson,
					fetchedAt: decision.fetchedAt,
					expiresAt: decision.expiresAt,
					approxBytes: decision.approxBytes,
				};
				yield* backend.writeOne(row);
			});

		const getOrFetch = <E, R>(
			k: K,
			fetcher: (hint: RevalidationHint<V>) => Effect.Effect<FetcherResult<V>, E, R>,
		): Effect.Effect<V, E | CacheMiss, R | DbService> =>
			Effect.gen(function* () {
				const key = keyer(k);
				const dedupKey = fullKey(key);
				const row = yield* backend.readOne(namespace, key);
				const now = Date.now();

				// Freshness check: if the row is fresh, return it outright.
				let previousRow: CacheRow | null = row;
				if (row) {
					const decision = policy.decideRead(row, now);
					if (decision === 'fresh') {
						const parsed = tryParse(row.valueJson);
						if (parsed !== null) {
							counters.hits++;
							return parsed;
						}
						// Fall through to refetch on corrupt payload.
						yield* backend.deleteOne(namespace, key);
						previousRow = null;
					} else if (decision === 'drop') {
						yield* backend.deleteOne(namespace, key);
						previousRow = null;
					}
					// 'stale' keeps `previousRow` populated so the fetcher can do
					// conditional requests via the hint.
				}

				// Concurrent-fetch dedup: share any in-flight Promise.
				const pending = inflight.get(dedupKey);
				if (pending) {
					counters.inflightDedups++;
					return yield* Effect.tryPromise({
						try: () => pending,
						catch: (err) => err as E | CacheMiss,
					});
				}

				counters.misses++;

				const hint: RevalidationHint<V> = {
					previousValue: previousRow
						? tryParse(previousRow.valueJson)
						: null,
					previousEtag: previousRow?.etag ?? null,
					previousLastModified: previousRow?.lastModified ?? null,
					previousRow,
				};

				const writeResult = (
					result: FetcherResult<V>,
				): Effect.Effect<V, CacheMiss, DbService> =>
					Effect.gen(function* () {
						const decision = policy.decideWrite<V>(
							result,
							previousRow,
							Date.now(),
						);
						if (decision.kind === 'drop') {
							yield* backend.deleteOne(namespace, key);
							return yield* Effect.fail(new CacheMiss(namespace, key));
						}
						if (decision.kind === 'touch') {
							counters.revalidatedUnchanged++;
							if (previousRow) {
								const refreshed: CacheRow = {
									...previousRow,
									fetchedAt: decision.fetchedAt,
									expiresAt: decision.expiresAt,
								};
								yield* backend.writeOne(refreshed);
								// Rough "bytes saved": the body we didn't need to refetch.
								counters.bytesSaved += previousRow.approxBytes;
								const parsed = tryParse(previousRow.valueJson);
								if (parsed !== null) return parsed;
							}
							return yield* Effect.fail(new CacheMiss(namespace, key));
						}
						// persist
						const written: CacheRow = {
							ns: namespace,
							key,
							valueJson: decision.valueJson,
							etag: decision.etag,
							lastModified: decision.lastModified,
							tagJson: decision.tagJson,
							fetchedAt: decision.fetchedAt,
							expiresAt: decision.expiresAt,
							approxBytes: decision.approxBytes,
						};
						yield* backend.writeOne(written);
						const parsed = tryParse(written.valueJson);
						if (parsed === null) {
							// Shouldn't happen — we just produced the JSON — but fail safely.
							return yield* Effect.fail(new CacheMiss(namespace, key));
						}
						return parsed;
					});

				const runtime = yield* Effect.runtime<R | DbService>();
				const runPromise = Runtime.runPromise(runtime);
				// Materialize Effect failures as typed Promise rejections via
				// `Effect.either` — without this, `runPromise` wraps failures in
				// a `FiberFailure` and the error's original shape is lost.
				const materialized = fetcher(hint).pipe(
					Effect.flatMap(writeResult),
					Effect.either,
				);
				const promise: Promise<V> = runPromise(materialized).then((either) => {
					if (either._tag === 'Right') return either.right;
					return Promise.reject(either.left);
				});

				inflight.set(dedupKey, promise);
				try {
					return yield* Effect.tryPromise({
						try: () => promise,
						catch: (err) => err as E | CacheMiss,
					});
				} finally {
					inflight.delete(dedupKey);
				}
			});

		const invalidate = (k: K, _reason: string) =>
			Effect.gen(function* () {
				const key = keyer(k);
				yield* backend.deleteOne(namespace, key);
				inflight.delete(fullKey(key));
			});

		const invalidatePrefix = (keyPrefix: string, _reason: string) =>
			Effect.gen(function* () {
				yield* backend.deleteByPrefix(namespace, keyPrefix);
				const pref = `${namespace}\0${keyPrefix}`;
				for (const k of [...inflight.keys()]) {
					if (k.startsWith(pref)) inflight.delete(k);
				}
			});

		const invalidateAll = (_reason: string) =>
			Effect.gen(function* () {
				yield* backend.deleteNamespace(namespace);
				const pref = `${namespace}\0`;
				for (const k of [...inflight.keys()]) {
					if (k.startsWith(pref)) inflight.delete(k);
				}
			});

		return {
			namespace,
			get,
			set,
			getOrFetch,
			invalidate,
			invalidatePrefix,
			invalidateAll,
			counters,
		} satisfies CacheLayer<K, V>;
	});
}
