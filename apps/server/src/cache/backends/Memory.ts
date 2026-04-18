import { Effect } from 'effect';
import type { DbService } from '../../services/Db';
import type { StorageBackend } from '../Storage';
import type { CacheRow } from '../types';

/**
 * In-process Map backend. Ephemeral — content is lost on restart.
 *
 * Two roles:
 *   1. Hot-path mirror inside a {@link LayeredBackend} (keep SQLite off the
 *      critical path for hot reads).
 *   2. Tests + cases where durability is actively undesirable.
 *
 * Expiry is lazy: rows are checked on read, not swept in the background.
 * `sweepExpired` walks the map on demand.
 */
export function createMemoryBackend(): StorageBackend {
	const table = new Map<string, CacheRow>();
	const fullKey = (ns: string, key: string) => `${ns}\0${key}`;

	const isExpired = (row: CacheRow, now: number): boolean => {
		if (row.expiresAt === null) return false;
		const t = Date.parse(row.expiresAt);
		return Number.isFinite(t) && now > t;
	};

	const readOne = (
		ns: string,
		key: string,
	): Effect.Effect<CacheRow | null, never, DbService> =>
		Effect.sync(() => {
			const row = table.get(fullKey(ns, key));
			if (!row) return null;
			if (isExpired(row, Date.now())) {
				table.delete(fullKey(ns, key));
				return null;
			}
			return row;
		});

	const writeOne = (row: CacheRow): Effect.Effect<void, never, DbService> =>
		Effect.sync(() => {
			table.set(fullKey(row.ns, row.key), row);
		});

	const deleteOne = (ns: string, key: string) =>
		Effect.sync(() => {
			table.delete(fullKey(ns, key));
		});

	const deleteByPrefix = (ns: string, keyPrefix: string) =>
		Effect.sync(() => {
			const pref = `${ns}\0${keyPrefix}`;
			for (const k of [...table.keys()]) {
				if (k.startsWith(pref)) table.delete(k);
			}
		});

	const deleteNamespace = (ns: string) =>
		Effect.sync(() => {
			const pref = `${ns}\0`;
			for (const k of [...table.keys()]) {
				if (k.startsWith(pref)) table.delete(k);
			}
		});

	const countEntries = (ns: string) =>
		Effect.sync(() => {
			let entries = 0;
			let approxBytes = 0;
			const pref = `${ns}\0`;
			for (const [k, row] of table) {
				if (k.startsWith(pref)) {
					entries++;
					approxBytes += row.approxBytes;
				}
			}
			return { entries, approxBytes };
		});

	const bounds = (ns: string) =>
		Effect.sync(() => {
			let oldestAt: string | null = null;
			let newestAt: string | null = null;
			const pref = `${ns}\0`;
			for (const [k, row] of table) {
				if (!k.startsWith(pref)) continue;
				if (oldestAt === null || row.fetchedAt < oldestAt) oldestAt = row.fetchedAt;
				if (newestAt === null || row.fetchedAt > newestAt) newestAt = row.fetchedAt;
			}
			return { oldestAt, newestAt };
		});

	const sweepExpired = () =>
		Effect.sync(() => {
			const now = Date.now();
			let swept = 0;
			for (const [k, row] of [...table]) {
				if (isExpired(row, now)) {
					table.delete(k);
					swept++;
				}
			}
			return swept;
		});

	return {
		kind: 'memory',
		readOne,
		writeOne,
		deleteOne,
		deleteByPrefix,
		deleteNamespace,
		countEntries,
		bounds,
		sweepExpired,
	};
}
