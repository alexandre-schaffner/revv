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

interface FadeParams {
  duration?: number;
  delay?: number;
  /** Initial y-offset in px; element settles to y:0. Default 0 (no translate). */
  y?: number;
}

function fadeTransform(node: Element, params: FadeParams = {}): TransitionConfig {
  const durationSec = prefersReducedMotion() ? 0 : (params.duration ?? tokens.quick);
  const el = node as HTMLElement;
  const yPx = params.y ?? 0;
  return {
    duration: durationSec * 1000,
    delay: (params.delay ?? 0) * 1000,
    easing: easeOutExpo,
    tick: (t, u) => {
      el.style.opacity = String(t);
      if (yPx) el.style.transform = `translateY(${u * yPx}px)`;
    },
  };
}

export const gsapFade = (node: Element, params: { duration?: number; delay?: number } = {}) =>
  fadeTransform(node, params);

export const gsapFadeY = (node: Element, params: FadeParams = {}) =>
  fadeTransform(node, { ...params, y: params.y ?? 4 });

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
      // Entry done: drop the inline styles so the element resumes natural
      // sizing. Without this, the measured `height: …px` set on the final
      // tick stays locked, and any later layout change inside the element
      // (e.g. an inner bits-ui Collapsible closing) leaves a phantom gap.
      if (t >= 1) {
        el.style.overflow = "";
        el.style.opacity = "";
        el.style[dim] = "";
        el.style[padA] = "";
        el.style[padB] = "";
        el.style[marA] = "";
        el.style[marB] = "";
        return;
      }
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
