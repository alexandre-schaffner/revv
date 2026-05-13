/**
 * Layout / shared-element helpers — the place we earn the full `motion`
 * package's weight. Imports from `motion` (NOT `motion/mini`) are isolated
 * to this file so Vite chunk-splits the heavier surface.
 *
 *   morphInto(fromEl, toEl, options)
 *     FLIP-based cross-element morph. Animates a transient clone of
 *     `fromEl` to land on `toEl`'s bounding box, then hands over visually.
 *     Used when one element conceptually "becomes" another — e.g. the
 *     onboarding brand mark morphing from the welcome center stage into
 *     a small header badge on subsequent steps.
 *
 * Both helpers honor `prefersReducedMotion()` and are safe under the
 * "node detached mid-animation" race (early return if either ref is gone).
 */

import { animate, type DOMKeyframesDefinition } from 'motion';
import { DURATION, EASING } from './tokens';
import { prefersReducedMotion } from './reduced-motion.svelte';

interface MorphOptions {
	duration?: number;
	easing?: readonly [number, number, number, number];
}

/**
 * Morph `fromEl` into `toEl` using the FLIP technique:
 *
 *   1. Snapshot the two bounding rects.
 *   2. Hide both originals and mount an absolutely-positioned clone of
 *      `fromEl` at the source rect, parented to <body> so it isn't clipped
 *      by ancestor `overflow: hidden` or transformed by ancestor stacking
 *      contexts.
 *   3. Animate the clone's `transform` to the delta needed to land on
 *      `toEl`'s rect (translate + scale).
 *   4. On finish, remove the clone and reveal `toEl`. `fromEl` stays
 *      hidden — the caller is expected to unmount or repurpose it.
 *
 * The clone takes its visuals from the original via `cloneNode(true)`,
 * which captures inline styles, classes, and inner DOM but NOT computed
 * styles. For brand marks this is fine — the styles that matter are on
 * the element itself, not inherited.
 *
 * If either element is missing from the DOM at call time, this resolves
 * immediately so callers can fire-and-forget without null checks.
 *
 * When `prefersReducedMotion()` is true, this skips the animation entirely
 * (no clone, no transform) — `toEl` becomes visible immediately. This is
 * intentionally cruder than scaling the duration to 1ms because the morph
 * carries no semantic content; it's pure visual continuity.
 */
export async function morphInto(
	fromEl: HTMLElement | null | undefined,
	toEl: HTMLElement | null | undefined,
	options: MorphOptions = {},
): Promise<void> {
	if (!fromEl || !toEl) return;
	if (!document.body.contains(fromEl) || !document.body.contains(toEl)) return;

	if (prefersReducedMotion()) {
		toEl.style.opacity = '1';
		toEl.style.visibility = 'visible';
		fromEl.style.visibility = 'hidden';
		return;
	}

	const fromRect = fromEl.getBoundingClientRect();
	const toRect = toEl.getBoundingClientRect();

	// Both elements need non-zero dimensions to compute a meaningful delta.
	// A 0×0 rect means the element is `display: none` or detached — bail.
	if (fromRect.width === 0 || fromRect.height === 0) return;
	if (toRect.width === 0 || toRect.height === 0) return;

	const dx = toRect.left - fromRect.left;
	const dy = toRect.top - fromRect.top;
	const sx = toRect.width / fromRect.width;
	const sy = toRect.height / fromRect.height;

	const clone = fromEl.cloneNode(true) as HTMLElement;
	clone.style.position = 'fixed';
	clone.style.top = `${fromRect.top}px`;
	clone.style.left = `${fromRect.left}px`;
	clone.style.width = `${fromRect.width}px`;
	clone.style.height = `${fromRect.height}px`;
	clone.style.margin = '0';
	clone.style.pointerEvents = 'none';
	clone.style.transformOrigin = 'top left';
	clone.style.zIndex = '9999';
	clone.style.willChange = 'transform';

	document.body.appendChild(clone);
	fromEl.style.visibility = 'hidden';
	toEl.style.visibility = 'hidden';

	const duration = (options.duration ?? DURATION.slow) / 1000;
	const easing = options.easing ?? EASING.outExpo;

	const keyframes: DOMKeyframesDefinition = {
		x: [0, dx],
		y: [0, dy],
		scaleX: [1, sx],
		scaleY: [1, sy],
	};

	try {
		// `animate` has multiple overloads where HTMLElement structurally
		// satisfies both the element and the object signature. TS picks the
		// object overload first and bails. Cast through `unknown` to force
		// the element form — runtime accepts the HTMLElement form fine.
		const animateEl = animate as unknown as (
			el: HTMLElement,
			kf: DOMKeyframesDefinition,
			opts: { duration: number; ease: number[] },
		) => { finished: Promise<unknown> };
		await animateEl(clone, keyframes, {
			duration,
			ease: easing as unknown as number[],
		}).finished;
	} catch {
		// motion may throw if the element is removed mid-animation —
		// the cleanup in finally still runs.
	} finally {
		clone.remove();
		toEl.style.visibility = 'visible';
		// Leave fromEl hidden; the caller owns its lifecycle (typically it's
		// unmounted with the welcome step when the morph resolves).
	}
}
