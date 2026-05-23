/**
 * Svelte custom transitions. Token-aware defaults; reduced-motion collapses
 * duration to zero.
 *
 * Svelte's transition contract requires a JS `easing` function (it can't
 * accept GSAP's `CustomEase` strings), so the cubic-bezier curves from
 * `app.css` are mirrored here as JS approximations. Keep these in shape
 * with `--ease-out-expo` and `--ease-soft`.
 */
import type { TransitionConfig } from "svelte/transition";

import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

// cubic-bezier(0.16, 1, 0.3, 1)
const easeOutExpo = (t: number): number => (t === 1 ? 1 : 1 - 2 ** (-10 * t));

// cubic-bezier(0.4, 0, 0.2, 1)
const easeSoft = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

interface TransformParams {
  duration?: number;
  delay?: number;
  /** Initial y-offset in px; element settles to y:0. */
  y?: number;
  /** Initial scale; element settles to scale:1. */
  start?: number;
  /** Initial opacity; element settles to opacity:1. Defaults to 0. */
  opacity?: number;
}

function transform(node: Element, params: TransformParams = {}): TransitionConfig {
  const durationSec = prefersReducedMotion() ? 0 : (params.duration ?? tokens.quick);
  const el = node as HTMLElement;
  const startOpacity = params.opacity ?? 0;
  const yPx = params.y ?? 0;
  const startScale = params.start ?? 1;
  return {
    duration: durationSec * 1000,
    delay: (params.delay ?? 0) * 1000,
    easing: easeOutExpo,
    tick: (t, u) => {
      el.style.opacity = String(startOpacity + (1 - startOpacity) * t);
      const transforms: string[] = [];
      if (yPx) transforms.push(`translateY(${u * yPx}px)`);
      if (startScale !== 1) transforms.push(`scale(${1 - u * (1 - startScale)})`);
      el.style.transform = transforms.join(" ");
    },
  };
}

export const gsapFade = (node: Element, params: { duration?: number; delay?: number } = {}) =>
  transform(node, params);

export const gsapFadeY = (
  node: Element,
  params: { duration?: number; delay?: number; y?: number } = {},
) => transform(node, { ...params, y: params.y ?? 4 });

export const gsapScale = (
  node: Element,
  params: { duration?: number; delay?: number; start?: number; opacity?: number } = {},
) => transform(node, { ...params, start: params.start ?? 0.96 });

/**
 * Height/width-collapsing slide (drop-in for svelte/transition's `slide`).
 * Lives apart from `transform` because it measures and animates layout
 * dimensions, not just opacity + transform.
 */
export function gsapSlide(
  node: Element,
  params: { duration?: number; delay?: number; axis?: "y" | "x" } = {},
): TransitionConfig {
  const durationSec = prefersReducedMotion() ? 0 : (params.duration ?? tokens.smooth);
  const el = node as HTMLElement;
  const axis = params.axis ?? "y";
  const dim = axis === "y" ? "height" : "width";
  const padA = axis === "y" ? "paddingTop" : "paddingLeft";
  const padB = axis === "y" ? "paddingBottom" : "paddingRight";
  const marA = axis === "y" ? "marginTop" : "marginLeft";
  const marB = axis === "y" ? "marginBottom" : "marginRight";
  const s = getComputedStyle(el);
  const size = parseFloat(s[dim]) || 0;
  const pA = parseFloat(s[padA]) || 0;
  const pB = parseFloat(s[padB]) || 0;
  const mA = parseFloat(s[marA]) || 0;
  const mB = parseFloat(s[marB]) || 0;
  return {
    duration: durationSec * 1000,
    delay: (params.delay ?? 0) * 1000,
    easing: easeSoft,
    tick: (t) => {
      el.style.overflow = "hidden";
      el.style.opacity = String(Math.min(1, t * 1.5));
      el.style[dim] = `${t * size}px`;
      el.style[padA] = `${t * pA}px`;
      el.style[padB] = `${t * pB}px`;
      el.style[marA] = `${t * mA}px`;
      el.style[marB] = `${t * mB}px`;
    },
  };
}
