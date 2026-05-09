/**
 * Motion tokens — TS mirror of the CSS custom properties in app.css.
 *
 * Why duplicate? JS consumers (Svelte transitions, motion JS animate calls)
 * need numbers and arrays, not strings. Reading via `getComputedStyle`
 * forces style recalc per call and layout-thrashes during stagger reveals.
 * The trade-off is hand-syncing two files; comments cross-reference both
 * directions so neither side rots silently.
 *
 * If you change a value, update app.css too (and vice-versa).
 */

/** Durations in milliseconds. Mirrored at app.css `--duration-*`. */
export const DURATION = {
	instant: 80,
	snap: 120,
	quick: 160,
	smooth: 220,
	slow: 320,
	page: 480,
} as const;

export type DurationKey = keyof typeof DURATION;

/**
 * Cubic-bezier easings as 4-tuples. Mirrored at app.css `--ease-*`.
 * Use as array directly with motion JS `animate(el, {...}, { ease: EASING.outExpo })`.
 */
export const EASING = {
	soft: [0.4, 0, 0.2, 1],
	outExpo: [0.16, 1, 0.3, 1],
	standard: [0.22, 0.61, 0.36, 1],
	anticipate: [0.68, -0.55, 0.27, 1.55],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export type EasingKey = keyof typeof EASING;

/**
 * Spring presets for motion JS. Springs have JS consumers only;
 * not exposed as CSS custom properties.
 *
 *   - snappy : default UI feel, settles in ~250ms
 *   - gentle : softer, for non-essential decoration
 *   - bouncy : playful, reserve for delight moments
 */
export const SPRING = {
	snappy: { type: 'spring' as const, stiffness: 350, damping: 30, mass: 1 },
	gentle: { type: 'spring' as const, stiffness: 200, damping: 25, mass: 1 },
	bouncy: { type: 'spring' as const, stiffness: 500, damping: 18, mass: 0.6 },
} as const;

export type SpringKey = keyof typeof SPRING;

/** Stagger step in milliseconds. Mirrored at app.css `--stagger-*`. */
export const STAGGER = {
	tight: 25,
	default: 40,
	loose: 80,
} as const;

export type StaggerKey = keyof typeof STAGGER;
