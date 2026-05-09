/**
 * `prefers-reduced-motion` as a $state singleton.
 *
 * One MQL listener at module init; every consumer reads via the getter
 * and re-renders automatically when the OS preference flips. Browser-
 * guarded for SvelteKit's static-adapter prerender (`window` undefined).
 */

let value = $state(false);

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
	const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
	value = mql.matches;
	mql.addEventListener('change', (e) => {
		value = e.matches;
	});
}

/** Reactive — components using this rerun on OS preference flip. */
export function prefersReducedMotion(): boolean {
	return value;
}
