/**
 * Svelte custom transition functions backed by GSAP.
 *
 * Svelte's transition contract: a function `(node, params) => { duration, tick, css?, easing? }`.
 * We use `tick` (not `css`) so GSAP owns the interpolation — keeps a single
 * source of truth for easing and avoids generating per-transition keyframe
 * rules at runtime.
 *
 * Drop-in replacements for `svelte/transition`:
 *   import { gsapFade, gsapSlide, gsapScale } from "$lib/motion/transitions";
 *   <div transition:gsapFade>
 *   <div transition:gsapSlide={{ axis: "y" }}>
 *   <div transition:gsapScale>
 */
import type { TransitionConfig } from "svelte/transition";

import { prefersReducedMotion } from "./match-media";
import { tokens } from "./tokens";

interface FadeParams {
  duration?: number;
  delay?: number;
}

// Cubic-bezier(0.16, 1, 0.3, 1) — outExpo, evaluated numerically.
function easeOutExpoFn(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

// Cubic-bezier(0.4, 0, 0.2, 1) — soft, evaluated as an approximation.
function easeSoftFn(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Fade in/out with optional y-translate.
 *
 * Note: Svelte invokes `tick(t, u)` where `t` is the eased progress 0..1 and
 * `u` is `1 - t`. For an `in:` transition, t starts at 0 and goes to 1; for
 * `out:` it goes from 1 to 0. We can therefore write opacity directly to `t`
 * and translate proportional to `u`.
 */
export function gsapFadeY(
  node: Element,
  params: { duration?: number; delay?: number; y?: number } = {},
): TransitionConfig {
  const reduce = prefersReducedMotion();
  const durationSec = reduce ? 0 : params.duration ?? tokens.quick;
  const yPx = params.y ?? 4;
  const el = node as HTMLElement;
  return {
    duration: durationSec * 1000,
    delay: (params.delay ?? 0) * 1000,
    easing: easeOutExpoFn,
    tick: (t: number, u: number) => {
      el.style.opacity = String(t);
      el.style.transform = `translateY(${u * yPx}px)`;
    },
  };
}

/**
 * Plain fade (opacity-only). Drop-in for `svelte/transition`'s `fade`.
 */
export const gsapFade = (
  node: Element,
  params: FadeParams = {},
): TransitionConfig => {
  const reduce = prefersReducedMotion();
  const durationSec = reduce ? 0 : params.duration ?? tokens.quick;
  const el = node as HTMLElement;
  return {
    duration: durationSec * 1000,
    delay: (params.delay ?? 0) * 1000,
    easing: easeOutExpoFn,
    tick: (t: number) => {
      el.style.opacity = String(t);
    },
  };
};

/**
 * Slide on a measured dimension (height by default). Mirrors svelte/transition's
 * `slide` but uses our motion tokens and a smoother easing.
 */
export function gsapSlide(
  node: Element,
  params: { duration?: number; delay?: number; axis?: "y" | "x" } = {},
): TransitionConfig {
  const reduce = prefersReducedMotion();
  const durationSec = reduce ? 0 : params.duration ?? tokens.smooth;
  const el = node as HTMLElement;
  const axis = params.axis ?? "y";
  const dimension = axis === "y" ? "height" : "width";
  const padStart = axis === "y" ? "paddingTop" : "paddingLeft";
  const padEnd = axis === "y" ? "paddingBottom" : "paddingRight";
  const marginStart = axis === "y" ? "marginTop" : "marginLeft";
  const marginEnd = axis === "y" ? "marginBottom" : "marginRight";
  const styles = getComputedStyle(el);
  const fullSize = parseFloat(styles[dimension as "height" | "width"]) || 0;
  const startPad = parseFloat(styles[padStart as "paddingTop"]) || 0;
  const endPad = parseFloat(styles[padEnd as "paddingBottom"]) || 0;
  const startMargin = parseFloat(styles[marginStart as "marginTop"]) || 0;
  const endMargin = parseFloat(styles[marginEnd as "marginBottom"]) || 0;
  return {
    duration: durationSec * 1000,
    delay: (params.delay ?? 0) * 1000,
    easing: easeSoftFn,
    tick: (t: number) => {
      el.style.overflow = "hidden";
      el.style.opacity = String(Math.min(1, t * 1.5));
      el.style[dimension as "height" | "width"] = `${t * fullSize}px`;
      el.style[padStart as "paddingTop"] = `${t * startPad}px`;
      el.style[padEnd as "paddingBottom"] = `${t * endPad}px`;
      el.style[marginStart as "marginTop"] = `${t * startMargin}px`;
      el.style[marginEnd as "marginBottom"] = `${t * endMargin}px`;
    },
  };
}

/**
 * Scale + fade. Drop-in for `svelte/transition`'s `scale`.
 */
export function gsapScale(
  node: Element,
  params: { duration?: number; delay?: number; start?: number; opacity?: number } = {},
): TransitionConfig {
  const reduce = prefersReducedMotion();
  const durationSec = reduce ? 0 : params.duration ?? tokens.quick;
  const startScale = params.start ?? 0.96;
  const startOpacity = params.opacity ?? 0;
  const el = node as HTMLElement;
  return {
    duration: durationSec * 1000,
    delay: (params.delay ?? 0) * 1000,
    easing: easeOutExpoFn,
    tick: (t: number, u: number) => {
      el.style.opacity = String(startOpacity + (1 - startOpacity) * t);
      el.style.transform = `scale(${1 - u * (1 - startScale)})`;
    },
  };
}
