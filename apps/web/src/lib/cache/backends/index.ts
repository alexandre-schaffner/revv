import type { CacheBackend, Backend } from '../types';
import { memoryBackend } from './memory';

export { createMemoryBackend, memoryBackend } from './memory';

/**
 * Resolve a {@link Backend} hint to a concrete backend instance.
 *
 * In M1 everything maps to the in-memory singleton. M3 will override this
 * with IDB + Layered lookups once the `idb` dep is in place.
 */
export function resolveBackend(hint: Backend): CacheBackend {
	// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
	switch (hint) {
		case 'memory':
		case 'idb':
		case 'layered':
		case 'local-storage':
		default:
			return memoryBackend;
	}
}
