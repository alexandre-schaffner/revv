import type { InvalidationReason } from './types';

/**
 * Module-singleton registry of every live {@link QueryHandle} in the app.
 *
 * ### Why a registry?
 *
 * Server-driven invalidation (M4) needs an enumeration surface: when the
 * server broadcasts `cache:invalidated {scope:'pr:files', prId:X}`, we
 * need to look up every live query whose key starts with `diff:X:` and
 * flip its status to `stale`. Without a registry we'd have to thread a
 * subscription through every component.
 *
 * ### Memory footprint
 *
 * Handles register themselves via `WeakRef` so a component that unmounts
 * (and releases its handle) gets GC'd without the registry holding it
 * alive. A secondary map of keys → refs keeps lookups O(1).
 *
 * The registry itself is NOT reactive — it's an internal coordination
 * surface. Queries expose their own reactive state via `$state`.
 */

export interface RegisteredQuery {
	readonly key: string;
	/** Stable namespace prefix — derived as everything before the first `:`. */
	readonly namespace: string;
	readonly invalidate: (reason: InvalidationReason) => void;
	readonly refresh: () => void;
	readonly dispose: () => void;
}

const entries = new Map<string, Set<WeakRef<RegisteredQuery>>>();

function namespaceOf(key: string): string {
	const idx = key.indexOf(':');
	return idx === -1 ? key : key.slice(0, idx);
}

function clean(key: string, bucket: Set<WeakRef<RegisteredQuery>>) {
	let live = 0;
	for (const ref of [...bucket]) {
		if (ref.deref() === undefined) bucket.delete(ref);
		else live++;
	}
	if (live === 0) entries.delete(key);
}

export const queryRegistry = {
	register(handle: RegisteredQuery): void {
		const bucket = entries.get(handle.key) ?? new Set();
		bucket.add(new WeakRef(handle));
		entries.set(handle.key, bucket);
	},

	unregister(handle: RegisteredQuery): void {
		const bucket = entries.get(handle.key);
		if (!bucket) return;
		for (const ref of [...bucket]) {
			const h = ref.deref();
			if (h === handle || h === undefined) bucket.delete(ref);
		}
		if (bucket.size === 0) entries.delete(handle.key);
	},

	/** Invalidate a single key. Returns the number of handles notified. */
	invalidate(key: string, reason: InvalidationReason): number {
		const bucket = entries.get(key);
		if (!bucket) return 0;
		let notified = 0;
		for (const ref of [...bucket]) {
			const h = ref.deref();
			if (!h) {
				bucket.delete(ref);
				continue;
			}
			h.invalidate(reason);
			notified++;
		}
		clean(key, bucket);
		return notified;
	},

	/** Invalidate everything whose key starts with the given prefix. */
	invalidateByPrefix(prefix: string, reason: InvalidationReason): number {
		let notified = 0;
		for (const [key, bucket] of [...entries]) {
			if (!key.startsWith(prefix)) continue;
			for (const ref of [...bucket]) {
				const h = ref.deref();
				if (!h) {
					bucket.delete(ref);
					continue;
				}
				h.invalidate(reason);
				notified++;
			}
			clean(key, bucket);
		}
		return notified;
	},

	/** Invalidate everything in a namespace (first `:`-separated segment). */
	invalidateByNamespace(ns: string, reason: InvalidationReason): number {
		let notified = 0;
		for (const [key, bucket] of [...entries]) {
			if (namespaceOf(key) !== ns) continue;
			for (const ref of [...bucket]) {
				const h = ref.deref();
				if (!h) {
					bucket.delete(ref);
					continue;
				}
				h.invalidate(reason);
				notified++;
			}
			clean(key, bucket);
		}
		return notified;
	},

	/** Diagnostics — snapshot of registered query keys (for CacheInspector). */
	snapshot(): Array<{ key: string; namespace: string; handleCount: number }> {
		const out: Array<{ key: string; namespace: string; handleCount: number }> = [];
		for (const [key, bucket] of entries) {
			let live = 0;
			for (const ref of bucket) if (ref.deref()) live++;
			out.push({ key, namespace: namespaceOf(key), handleCount: live });
		}
		return out;
	},
};
