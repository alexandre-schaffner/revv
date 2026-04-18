import { Effect } from 'effect';
import type { StorageBackend } from '../Storage';

/**
 * Layered backend: memory + durable.
 *
 * Reads: memory first. If missing, falls back to durable; on durable hit,
 * writes the row through to memory (warm on first hit pattern). Writes:
 * go to both layers in parallel so concurrent readers converge quickly.
 *
 * This is the default backend for namespaces that want fast hot reads +
 * crash-safe persistence (most of them).
 */
export function createLayeredBackend(
	memory: StorageBackend,
	durable: StorageBackend,
): StorageBackend {
	return {
		kind: 'layered',
		readOne: (ns, key) =>
			Effect.gen(function* () {
				const mem = yield* memory.readOne(ns, key);
				if (mem !== null) return mem;
				const dur = yield* durable.readOne(ns, key);
				if (dur !== null) {
					// Warm memory on first hit; swallow errors — memory is best-effort.
					yield* memory.writeOne(dur).pipe(Effect.orDie);
				}
				return dur;
			}),
		writeOne: (row) =>
			Effect.all([memory.writeOne(row), durable.writeOne(row)], {
				concurrency: 'unbounded',
				discard: true,
			}),
		deleteOne: (ns, key) =>
			Effect.all([memory.deleteOne(ns, key), durable.deleteOne(ns, key)], {
				concurrency: 'unbounded',
				discard: true,
			}),
		deleteByPrefix: (ns, prefix) =>
			Effect.all(
				[memory.deleteByPrefix(ns, prefix), durable.deleteByPrefix(ns, prefix)],
				{ concurrency: 'unbounded', discard: true },
			),
		deleteNamespace: (ns) =>
			Effect.all(
				[memory.deleteNamespace(ns), durable.deleteNamespace(ns)],
				{ concurrency: 'unbounded', discard: true },
			),
		// Durable is authoritative for counts/bounds — memory is a subset.
		countEntries: (ns) => durable.countEntries(ns),
		bounds: (ns) => durable.bounds(ns),
		sweepExpired: () =>
			Effect.gen(function* () {
				const [memSwept, durSwept] = yield* Effect.all(
					[memory.sweepExpired(), durable.sweepExpired()],
					{ concurrency: 'unbounded' },
				);
				return memSwept + durSwept;
			}),
	};
}
