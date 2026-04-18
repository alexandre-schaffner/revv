/**
 * Integration tests for {@link makeCacheLayer}: wires a policy + backend +
 * stats registry and exercises the public API end-to-end using the in-memory
 * backend + a dummy DbService Layer.
 */

import { describe, test, expect } from 'bun:test';
import { Effect, Layer } from 'effect';
import {
	CacheMiss,
	CacheStats,
	CacheStatsLive,
	createMemoryBackend,
	ImmutablePolicy,
	makeCacheLayer,
	stringKey,
	TtlPolicy,
} from '../index';
import { DbService } from '../../services/Db';

const DummyDbLayer = Layer.succeed(
	DbService,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	{ db: {} as any },
);

const harness = <A, E>(eff: Effect.Effect<A, E, DbService | CacheStats>) =>
	Effect.runPromise(
		Effect.provide(eff, Layer.mergeAll(DummyDbLayer, CacheStatsLive)),
	);

describe('CacheLayer', () => {
	test('get returns null on miss; set + get round-trips', async () => {
		await harness(
			Effect.gen(function* () {
				const stats = yield* CacheStats;
				const layer = yield* makeCacheLayer<string, { a: number }>({
					namespace: 'test:basic',
					backend: createMemoryBackend(),
					policy: new ImmutablePolicy(),
					keyer: stringKey,
					stats,
				});

				expect(yield* layer.get('k')).toBeNull();
				yield* layer.set('k', { a: 1 });
				expect(yield* layer.get('k')).toEqual({ a: 1 });
			}),
		);
	});

	test('getOrFetch runs fetcher on miss and caches', async () => {
		await harness(
			Effect.gen(function* () {
				const stats = yield* CacheStats;
				const layer = yield* makeCacheLayer<string, number>({
					namespace: 'test:fetcher',
					backend: createMemoryBackend(),
					policy: new ImmutablePolicy(),
					keyer: stringKey,
					stats,
				});

				let calls = 0;
				const fetcher = () =>
					Effect.sync(() => {
						calls++;
						return { kind: 'fresh' as const, value: 42 };
					});

				const v1 = yield* layer.getOrFetch('k', fetcher);
				const v2 = yield* layer.getOrFetch('k', fetcher);
				expect(v1).toBe(42);
				expect(v2).toBe(42);
				// Fetcher ran exactly once — second call was a cache hit.
				expect(calls).toBe(1);
			}),
		);
	});

	test('getOrFetch dedups concurrent callers', async () => {
		await harness(
			Effect.gen(function* () {
				const stats = yield* CacheStats;
				const layer = yield* makeCacheLayer<string, string>({
					namespace: 'test:dedup',
					backend: createMemoryBackend(),
					policy: new ImmutablePolicy(),
					keyer: stringKey,
					stats,
				});

				let calls = 0;
				// Slow fetcher — simulates a network round-trip so concurrent callers
				// arrive while the promise is still pending.
				const fetcher = () =>
					Effect.promise(async () => {
						calls++;
						await new Promise((r) => setTimeout(r, 20));
						return { kind: 'fresh' as const, value: 'value' };
					});

				const [a, b, c] = yield* Effect.all(
					[
						layer.getOrFetch('k', fetcher),
						layer.getOrFetch('k', fetcher),
						layer.getOrFetch('k', fetcher),
					],
					{ concurrency: 'unbounded' },
				);
				expect([a, b, c]).toEqual(['value', 'value', 'value']);
				expect(calls).toBe(1);
				expect(layer.counters.inflightDedups).toBeGreaterThanOrEqual(2);
			}),
		);
	});

	test('TTL policy: stale entry triggers refetch via getOrFetch', async () => {
		await harness(
			Effect.gen(function* () {
				const stats = yield* CacheStats;
				const layer = yield* makeCacheLayer<string, string>({
					namespace: 'test:ttl',
					backend: createMemoryBackend(),
					policy: new TtlPolicy(10),
					keyer: stringKey,
					stats,
				});

				let calls = 0;
				const fetcher = () =>
					Effect.sync(() => {
						calls++;
						return { kind: 'fresh' as const, value: `call-${calls}` };
					});

				const v1 = yield* layer.getOrFetch('k', fetcher);
				// Wait past the TTL so decideRead returns 'stale'.
				yield* Effect.promise(() => new Promise((r) => setTimeout(r, 25)));
				const v2 = yield* layer.getOrFetch('k', fetcher);
				expect(v1).toBe('call-1');
				expect(v2).toBe('call-2');
			}),
		);
	});

	test('invalid fetcher result surfaces CacheMiss', async () => {
		await harness(
			Effect.gen(function* () {
				const stats = yield* CacheStats;
				const layer = yield* makeCacheLayer<string, string>({
					namespace: 'test:invalid',
					backend: createMemoryBackend(),
					policy: new ImmutablePolicy(),
					keyer: stringKey,
					stats,
				});

				const result = yield* layer
					.getOrFetch('k', () =>
						Effect.succeed({ kind: 'invalid' as const }),
					)
					.pipe(Effect.either);
				expect(result._tag).toBe('Left');
				if (result._tag === 'Left') {
					expect(result.left).toBeInstanceOf(CacheMiss);
				}
			}),
		);
	});

	test('invalidate drops cached value', async () => {
		await harness(
			Effect.gen(function* () {
				const stats = yield* CacheStats;
				const layer = yield* makeCacheLayer<string, string>({
					namespace: 'test:invalidate',
					backend: createMemoryBackend(),
					policy: new ImmutablePolicy(),
					keyer: stringKey,
					stats,
				});

				yield* layer.set('a', 'x');
				yield* layer.set('b', 'y');
				yield* layer.invalidate('a', 'test');
				expect(yield* layer.get('a')).toBeNull();
				expect(yield* layer.get('b')).toBe('y');
			}),
		);
	});

	test('invalidateAll drops namespace', async () => {
		await harness(
			Effect.gen(function* () {
				const stats = yield* CacheStats;
				const layer = yield* makeCacheLayer<string, string>({
					namespace: 'test:drop-all',
					backend: createMemoryBackend(),
					policy: new ImmutablePolicy(),
					keyer: stringKey,
					stats,
				});

				yield* layer.set('a', 'x');
				yield* layer.set('b', 'y');
				yield* layer.invalidateAll('test');
				expect(yield* layer.get('a')).toBeNull();
				expect(yield* layer.get('b')).toBeNull();
			}),
		);
	});

	test('stats.snapshot reports registered namespaces', async () => {
		await harness(
			Effect.gen(function* () {
				const stats = yield* CacheStats;
				const layer = yield* makeCacheLayer<string, string>({
					namespace: 'test:stats',
					backend: createMemoryBackend(),
					policy: new ImmutablePolicy(),
					keyer: stringKey,
					stats,
				});

				yield* layer.set('a', 'x');
				yield* layer.get('a'); // hit
				yield* layer.get('b'); // miss

				const snapshot = yield* stats.snapshot();
				const ns = snapshot.find((s) => s.namespace === 'test:stats');
				expect(ns).toBeDefined();
				expect(ns!.hits).toBe(1);
				expect(ns!.misses).toBe(1);
				expect(ns!.hitRate).toBeCloseTo(0.5, 5);
				expect(ns!.entries).toBe(1);
				expect(ns!.policy).toBe('immutable');
				expect(ns!.storage).toBe('memory');
			}),
		);
	});
});
