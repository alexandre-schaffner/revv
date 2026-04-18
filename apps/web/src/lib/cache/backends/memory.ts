import type { CacheBackend, CacheEntry } from '../types';

/**
 * In-memory backend — the only backend shipped in M1. Everything is kept
 * in a module-level `Map`, lost on reload. Good for Svelte-lifetime
 * state; M3 adds an IndexedDB backend and a layered composite.
 */
export function createMemoryBackend(): CacheBackend {
	const store = new Map<string, CacheEntry<unknown>>();

	return {
		kind: 'memory',
		read: async <T>(key: string) => {
			const entry = store.get(key);
			return (entry as CacheEntry<T> | undefined) ?? null;
		},
		write: async <T>(key: string, entry: CacheEntry<T>) => {
			store.set(key, entry as CacheEntry<unknown>);
		},
		remove: async (key: string) => {
			store.delete(key);
		},
		removeByPrefix: async (prefix: string) => {
			for (const k of [...store.keys()]) {
				if (k.startsWith(prefix)) store.delete(k);
			}
		},
		keys: async () => [...store.keys()],
	};
}

/** Default singleton — shared across createQuery call sites in M1. */
export const memoryBackend = createMemoryBackend();
