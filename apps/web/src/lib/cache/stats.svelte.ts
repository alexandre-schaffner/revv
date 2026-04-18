/**
 * Client-side cache observability counters.
 *
 * Svelte 5 `$state` backing so the Settings → Cache panel can read these
 * live without explicit subscriptions. Reset on reload — this isn't a
 * durable observability surface, just a dev/debug view.
 *
 * M6 / M7 extend this with outbox counters and IDB quota events.
 */

export interface CacheStatsSnapshot {
	readonly hits: number;
	readonly misses: number;
	readonly staleServes: number;
	readonly revalidations: number;
	readonly inflightDedups: number;
	readonly invalidations: number;
	readonly errors: number;
	readonly lastInvalidationAt: number | null;
	readonly perKey: ReadonlyMap<string, { hits: number; misses: number }>;
}

const state = $state<{
	hits: number;
	misses: number;
	staleServes: number;
	revalidations: number;
	inflightDedups: number;
	invalidations: number;
	errors: number;
	lastInvalidationAt: number | null;
	perKey: Map<string, { hits: number; misses: number }>;
}>({
	hits: 0,
	misses: 0,
	staleServes: 0,
	revalidations: 0,
	inflightDedups: 0,
	invalidations: 0,
	errors: 0,
	lastInvalidationAt: null,
	perKey: new Map(),
});

function bumpPerKey(key: string, field: 'hits' | 'misses') {
	const current = state.perKey.get(key) ?? { hits: 0, misses: 0 };
	current[field]++;
	state.perKey.set(key, current);
	// Reassign to trigger $state reactivity for consumers reading the Map.
	state.perKey = new Map(state.perKey);
}

export const cacheStats = {
	get snapshot(): CacheStatsSnapshot {
		return {
			hits: state.hits,
			misses: state.misses,
			staleServes: state.staleServes,
			revalidations: state.revalidations,
			inflightDedups: state.inflightDedups,
			invalidations: state.invalidations,
			errors: state.errors,
			lastInvalidationAt: state.lastInvalidationAt,
			perKey: state.perKey,
		};
	},
	recordHit(key: string) {
		state.hits++;
		bumpPerKey(key, 'hits');
	},
	recordMiss(key: string) {
		state.misses++;
		bumpPerKey(key, 'misses');
	},
	recordStaleServe() {
		state.staleServes++;
	},
	recordRevalidation() {
		state.revalidations++;
	},
	recordInflightDedup() {
		state.inflightDedups++;
	},
	recordInvalidation() {
		state.invalidations++;
		state.lastInvalidationAt = Date.now();
	},
	recordError() {
		state.errors++;
	},
	reset() {
		state.hits = 0;
		state.misses = 0;
		state.staleServes = 0;
		state.revalidations = 0;
		state.inflightDedups = 0;
		state.invalidations = 0;
		state.errors = 0;
		state.lastInvalidationAt = null;
		state.perKey = new Map();
	},
};
