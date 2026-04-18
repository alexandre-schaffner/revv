import { Context, Effect, Layer, Ref } from 'effect';
import type { DbService } from '../services/Db';
import type { StorageBackend } from './Storage';
import type { CacheCounters, CacheNamespaceStats } from './types';

/**
 * In-process counter registry shared by every {@link CacheLayer}.
 *
 * Counters are intentionally a plain mutable shape behind a `Ref` — the
 * hot path is `counters.hits++` on every cache read, and we want that to
 * be cheap. Each namespace registers itself at construction time and
 * reports the same pointer back to the aggregator.
 */
export interface NamespaceRegistration {
	readonly namespace: string;
	readonly policyKind: string;
	readonly backend: StorageBackend;
	readonly counters: CacheCounters;
}

export class CacheStats extends Context.Tag('CacheStats')<
	CacheStats,
	{
		readonly register: (reg: NamespaceRegistration) => Effect.Effect<void>;
		readonly snapshot: () => Effect.Effect<
			CacheNamespaceStats[],
			never,
			DbService
		>;
		readonly totals: () => Effect.Effect<
			{
				hits: number;
				misses: number;
				revalidatedUnchanged: number;
				inflightDedups: number;
				bytesSaved: number;
				entries: number;
				approxBytes: number;
			},
			never,
			DbService
		>;
		/** Reset all counters — for tests. */
		readonly reset: () => Effect.Effect<void>;
	}
>() {}

export const CacheStatsLive = Layer.effect(
	CacheStats,
	Effect.gen(function* () {
		const registry = yield* Ref.make<Map<string, NamespaceRegistration>>(
			new Map(),
		);

		const register = (reg: NamespaceRegistration) =>
			Ref.update(registry, (m) => {
				const next = new Map(m);
				next.set(reg.namespace, reg);
				return next;
			});

		const snapshot = () =>
			Effect.gen(function* () {
				const m = yield* Ref.get(registry);
				const out: CacheNamespaceStats[] = [];
				for (const reg of m.values()) {
					const { entries, approxBytes } = yield* reg.backend.countEntries(
						reg.namespace,
					);
					const { oldestAt, newestAt } = yield* reg.backend.bounds(
						reg.namespace,
					);
					const { hits, misses, revalidatedUnchanged, inflightDedups, bytesSaved } =
						reg.counters;
					const hitRate =
						hits + misses === 0 ? 0 : hits / (hits + misses);
					out.push({
						namespace: reg.namespace,
						policy: reg.policyKind,
						storage: reg.backend.kind,
						hits,
						misses,
						revalidatedUnchanged,
						inflightDedups,
						bytesSaved,
						entries,
						approxBytes,
						hitRate,
						oldestEntryAt: oldestAt,
						newestEntryAt: newestAt,
					});
				}
				return out;
			});

		const totals = () =>
			Effect.gen(function* () {
				const all = yield* snapshot();
				return all.reduce(
					(acc, r) => ({
						hits: acc.hits + r.hits,
						misses: acc.misses + r.misses,
						revalidatedUnchanged:
							acc.revalidatedUnchanged + r.revalidatedUnchanged,
						inflightDedups: acc.inflightDedups + r.inflightDedups,
						bytesSaved: acc.bytesSaved + r.bytesSaved,
						entries: acc.entries + r.entries,
						approxBytes: acc.approxBytes + r.approxBytes,
					}),
					{
						hits: 0,
						misses: 0,
						revalidatedUnchanged: 0,
						inflightDedups: 0,
						bytesSaved: 0,
						entries: 0,
						approxBytes: 0,
					},
				);
			});

		const reset = () =>
			Effect.gen(function* () {
				const m = yield* Ref.get(registry);
				for (const reg of m.values()) {
					reg.counters.hits = 0;
					reg.counters.misses = 0;
					reg.counters.revalidatedUnchanged = 0;
					reg.counters.inflightDedups = 0;
					reg.counters.bytesSaved = 0;
				}
			});

		return { register, snapshot, totals, reset };
	}),
);
