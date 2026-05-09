/**
 * Public surface for the motion system.
 *
 *   import {
 *     // tokens
 *     DURATION, EASING, SPRING, STAGGER,
 *     // reduced-motion reactive
 *     prefersReducedMotion,
 *     // Svelte transitions
 *     panelSlide, dialogSpring, popoverFade, tooltipPop,
 *     commandPaletteEnter, listItemEnter, softFade,
 *     // actions
 *     motion,
 *   } from '$lib/motion';
 *
 * Three categories of preset, three call patterns:
 *
 *   1. CSS keyframes  (in app.css; for bits-ui primitives)
 *      `[data-state="open"] { animation: motion-dialog-spring-in ... }`
 *
 *   2. Svelte transitions (this file's `transitions.ts`; for app code)
 *      `<div transition:popoverFade>`
 *
 *   3. Actions (this file's `actions.ts`; for state-change pulses/flashes)
 *      `<div use:motion={{ preset: 'pulse', trigger }}>`
 */

export * from './tokens';
export { prefersReducedMotion } from './reduced-motion.svelte';
export {
	panelSlide,
	dialogSpring,
	popoverFade,
	tooltipPop,
	commandPaletteEnter,
	listItemEnter,
	collapsibleSlide,
	softFade,
} from './transitions';
export { motion } from './actions';
