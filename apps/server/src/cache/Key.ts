import { createHash } from 'node:crypto';

/**
 * Keyer functions normalize caller-facing keys into the canonical string
 * stored by backends. Every {@link CacheLayer} wires exactly one keyer so the
 * namespace's call sites all agree on the key shape.
 *
 * The rule: a keyer is **pure** and **deterministic**. Same input → same
 * output byte-for-byte, always. Backends treat the output as an opaque
 * string — it's the keyer's job to avoid collisions.
 */
export interface Keyer<K> {
	(key: K): string;
}

/** Identity keyer — for namespaces keyed on a plain string already. */
export const stringKey: Keyer<string> = (k) => k;

/**
 * Tuple keyer — joins parts with `\0` (NUL). Safe because `\0` can't appear
 * in user-visible identifiers like repo full names, file paths, or refs.
 */
export function tupleKey<T extends readonly (string | number)[]>(...parts: T): string {
	return parts.map((p) => String(p)).join('\0');
}

/** Factory that returns a keyer from a tuple extractor. */
export function makeTupleKeyer<K>(
	extract: (k: K) => readonly (string | number)[],
): Keyer<K> {
	return (k) => extract(k).map((p) => String(p)).join('\0');
}

/**
 * SHA-256 keyer — for long or composite keys that shouldn't balloon the
 * SQLite index. Produces a 64-char hex digest; input is joined with `\0`
 * first so tuple order matters.
 */
export function hashKey(...parts: readonly (string | number)[]): string {
	const joined = parts.map((p) => String(p)).join('\0');
	return createHash('sha256').update(joined).digest('hex');
}

/** Factory that hashes the result of `extract`. */
export function makeHashKeyer<K>(
	extract: (k: K) => readonly (string | number)[],
): Keyer<K> {
	return (k) => hashKey(...extract(k));
}
