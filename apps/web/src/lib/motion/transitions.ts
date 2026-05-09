/**
 * Svelte transition presets.
 *
 * Each preset is a `(node, params) => TransitionConfig` factory matching
 * the shape Svelte 5's `transition:` directive expects. Use these in app
 * code for new components and any place that already uses `svelte/transition`.
 *
 * IMPORTANT: bits-ui primitives (dialog/popover/tooltip/select) drive their
 * open/close animations via CSS `[data-state]` selectors — Svelte transitions
 * cannot be applied to them. For those, use the matching `motion-*-in`
 * keyframes defined in app.css. The naming convention is parallel:
 *
 *   transitions.ts             app.css
 *   ─────────────────────────  ─────────────────────────────
 *   dialogSpring()             @keyframes motion-dialog-spring-in
 *   popoverFade()              @keyframes motion-popover-pop-in
 *   tooltipPop()               @keyframes motion-tooltip-pop-in
 *
 * Every preset honors `prefers-reduced-motion` by short-circuiting
 * to a near-instant transition (Svelte `transition:` won't tolerate `0`
 * for some configurations, so we use 1ms which matches the CSS reduce-
 * motion sledgehammer in app.css).
 */

import type { TransitionConfig } from 'svelte/transition';
import { DURATION, EASING } from './tokens';
import { prefersReducedMotion } from './reduced-motion.svelte';

/**
 * Cubic-bezier easing factory matching CSS `cubic-bezier(p1x, p1y, p2x, p2y)`.
 * Uses Newton-Raphson to solve t for given progress x, then evaluates y(t).
 * Tolerances chosen to be visually indistinguishable from the browser's
 * native CSS cubic-bezier at standard ~16ms frame budgets.
 */
function cubicBezierEasing(p1x: number, p1y: number, p2x: number, p2y: number): (x: number) => number {
	const cx = 3 * p1x;
	const bx = 3 * (p2x - p1x) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * p1y;
	const by = 3 * (p2y - p1y) - cy;
	const ay = 1 - cy - by;
	const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
	const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
	const sampleDerivX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
	return (x: number) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		let t = x;
		for (let i = 0; i < 8; i++) {
			const xt = sampleX(t) - x;
			if (Math.abs(xt) < 1e-5) return sampleY(t);
			const d = sampleDerivX(t);
			if (Math.abs(d) < 1e-6) break;
			t -= xt / d;
		}
		// Bisection fallback (rare).
		let lo = 0;
		let hi = 1;
		t = x;
		while (lo < hi) {
			const xt = sampleX(t);
			if (Math.abs(xt - x) < 1e-5) break;
			if (xt < x) lo = t;
			else hi = t;
			t = (lo + hi) / 2;
		}
		return sampleY(t);
	};
}

const easeSoft = cubicBezierEasing(...EASING.soft);
const easeOutExpo = cubicBezierEasing(...EASING.outExpo);

function reducedConfig(): TransitionConfig {
	return { duration: 1, css: () => '' };
}

/**
 * Slide-in from one of the four edges. Pairs nicely with sidebars and
 * sheets that don't go through bits-ui Dialog (which has its own scheme).
 */
export function panelSlide(
	_node: Element,
	{ side = 'right', duration = DURATION.smooth }: { side?: 'left' | 'right' | 'top' | 'bottom'; duration?: number } = {},
): TransitionConfig {
	if (prefersReducedMotion()) return reducedConfig();
	const axis = side === 'left' || side === 'right' ? 'X' : 'Y';
	const sign = side === 'left' || side === 'top' ? -1 : 1;
	return {
		duration,
		easing: easeOutExpo,
		css: (t) => `
			transform: translate${axis}(${(1 - t) * sign * 100}%);
			opacity: ${t};
		`,
	};
}

/**
 * Spring-in for app-level dialogs not built on bits-ui.
 * For bits-ui Dialog, use `@keyframes motion-dialog-spring-in` in CSS.
 */
export function dialogSpring(_node: Element, { duration = DURATION.slow } = {}): TransitionConfig {
	if (prefersReducedMotion()) return reducedConfig();
	return {
		duration,
		easing: easeOutExpo,
		css: (t) => `
			opacity: ${t};
			transform: scale(${0.96 + 0.04 * t}) translateY(${(1 - t) * 12}px);
		`,
	};
}

/** Quick fade-and-zoom for popovers. Mirror of `motion-popover-pop-in`. */
export function popoverFade(_node: Element, { duration = DURATION.snap } = {}): TransitionConfig {
	if (prefersReducedMotion()) return reducedConfig();
	return {
		duration,
		easing: easeOutExpo,
		css: (t) => `opacity: ${t}; transform: scale(${0.96 + 0.04 * t});`,
	};
}

/** Tooltip pop, biased downward. Mirror of `motion-tooltip-pop-in`. */
export function tooltipPop(_node: Element, { duration = DURATION.quick } = {}): TransitionConfig {
	if (prefersReducedMotion()) return reducedConfig();
	return {
		duration,
		easing: easeOutExpo,
		css: (t) => `
			opacity: ${t};
			transform: scale(${0.92 + 0.08 * t}) translateY(${(1 - t) * 4}px);
		`,
	};
}

/**
 * Command palette enter — replaces the inline fade+scale combination.
 * Slightly longer than the default popover so the palette feels
 * intentional, not snap.
 */
export function commandPaletteEnter(_node: Element, { duration = DURATION.quick } = {}): TransitionConfig {
	if (prefersReducedMotion()) return reducedConfig();
	return {
		duration,
		easing: easeOutExpo,
		css: (t) => `opacity: ${t}; transform: scale(${0.97 + 0.03 * t});`,
	};
}

/**
 * Generic list-item entry. Pair with `delay` driven by stagger logic at
 * the call site (Svelte transitions don't natively chain — caller passes
 * `{ delay: i * STAGGER.default }`).
 */
export function listItemEnter(
	_node: Element,
	{ duration = DURATION.quick, delay = 0 }: { duration?: number; delay?: number } = {},
): TransitionConfig {
	if (prefersReducedMotion()) return reducedConfig();
	return {
		duration,
		delay,
		easing: easeOutExpo,
		css: (t) => `opacity: ${t}; transform: translateY(${(1 - t) * 6}px);`,
	};
}

/**
 * Collapsible envelope — animates height + opacity for expand/collapse
 * containers (sidebar repo groups, accordion sections). Reads the node's
 * natural box on mount and interpolates from 0 → that. Pair with per-child
 * `listItemEnter` for staggered fanfare on the contents.
 */
export function collapsibleSlide(
	node: Element,
	{ duration = DURATION.smooth }: { duration?: number } = {},
): TransitionConfig {
	if (prefersReducedMotion()) return reducedConfig();
	const style = getComputedStyle(node);
	const height = parseFloat(style.height);
	const paddingTop = parseFloat(style.paddingTop);
	const paddingBottom = parseFloat(style.paddingBottom);
	const marginTop = parseFloat(style.marginTop);
	const marginBottom = parseFloat(style.marginBottom);
	const borderTop = parseFloat(style.borderTopWidth);
	const borderBottom = parseFloat(style.borderBottomWidth);
	return {
		duration,
		easing: easeOutExpo,
		css: (t) => `
			overflow: hidden;
			opacity: ${Math.min(t * 3, 1)};
			height: ${t * height}px;
			padding-top: ${t * paddingTop}px;
			padding-bottom: ${t * paddingBottom}px;
			margin-top: ${t * marginTop}px;
			margin-bottom: ${t * marginBottom}px;
			border-top-width: ${t * borderTop}px;
			border-bottom-width: ${t * borderBottom}px;
		`,
	};
}

/**
 * Soft fade — for content swaps where transform would distract.
 * Default duration matches `--duration-quick`.
 */
export function softFade(_node: Element, { duration = DURATION.quick } = {}): TransitionConfig {
	if (prefersReducedMotion()) return reducedConfig();
	return {
		duration,
		easing: easeSoft,
		css: (t) => `opacity: ${t};`,
	};
}
