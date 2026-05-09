/**
 * Svelte actions wrapping motion JS `animate()` (mini build, ~2.3KB).
 *
 *   <div use:motion={{ preset: 'pulse' }}>
 *
 * The full motion package is reserved for `layout.ts` (FLIP / shared-element).
 * Here we use `motion/mini` for entry/exit/state animations — covers the
 * 80% case at minimum cost.
 *
 * Lifecycle contract (don't break this): every `animate()` call returns a
 * controller. We MUST stop active controllers in the action's `destroy`,
 * or rapid mount/unmount (e.g. walkthrough chapter changes) leaves orphan
 * animations running on detached nodes.
 *
 * Reduced-motion contract: motion JS does NOT auto-respect the OS
 * preference. Every preset checks `prefersReducedMotion()` and either
 * skips the animation or runs it with duration: 0.
 */

import type { Action } from 'svelte/action';
import { animate } from 'motion/mini';
import { DURATION, EASING } from './tokens';
import { prefersReducedMotion } from './reduced-motion.svelte';

type AnimateControls = ReturnType<typeof animate>;

type Preset = 'pulse' | 'flash' | 'shake';

interface MotionParams {
	preset: Preset;
	/** Trigger the animation when this value changes (any non-undefined value). */
	trigger?: unknown;
}

/**
 * Use:
 *   <div use:motion={{ preset: 'pulse', trigger: someState }}>
 *
 * The `trigger` param re-runs the animation on change. Pass a counter,
 * a timestamp, or any value that increments per "fire."
 */
export const motion: Action<HTMLElement, MotionParams> = (node, initial) => {
	let active: AnimateControls | null = null;
	let lastTrigger = initial?.trigger;

	function play(preset: Preset) {
		if (prefersReducedMotion()) return;
		active?.stop();
		switch (preset) {
			case 'pulse':
				active = animate(
					node,
					{ scale: [1, 1.04, 1] },
					{ duration: DURATION.smooth / 1000, ease: EASING.outExpo },
				);
				break;
			case 'flash':
				active = animate(
					node,
					{ opacity: [1, 0.6, 1] },
					{ duration: DURATION.quick / 1000, ease: EASING.soft },
				);
				break;
			case 'shake':
				active = animate(
					node,
					{ x: [0, -3, 3, -2, 2, 0] },
					{ duration: DURATION.smooth / 1000, ease: EASING.standard },
				);
				break;
		}
	}

	if (initial?.trigger !== undefined) play(initial.preset);

	return {
		update(next) {
			if (next.trigger !== lastTrigger && next.trigger !== undefined) {
				lastTrigger = next.trigger;
				play(next.preset);
			}
		},
		destroy() {
			active?.stop();
			active = null;
		},
	};
};
