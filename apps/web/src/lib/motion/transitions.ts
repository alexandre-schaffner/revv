/**
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
  /** Initial y-offset in px. */
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
      // Dropped once settled: a leftover `translateY(0px)` would keep the
      // element a containing block for every `position: fixed` descendant.
      if (yPx) el.style.transform = t >= 1 ? "" : `translateY(${u * yPx}px)`;
    },
  };
}

export const gsapFade = (node: Element, params: { duration?: number; delay?: number } = {}) =>
  fadeTransform(node, params);

export const gsapFadeY = (node: Element, params: FadeParams = {}) =>
  fadeTransform(node, { ...params, y: params.y ?? 4 });

/**
 * Fade + scale, for swapping one glyph for another inside a fixed-size slot
 * (icon buttons, status dots).
 *
 * The caller must stack the keyed element — `position: absolute` centered in
 * a `position: relative` parent — so the outgoing and incoming glyphs
 * crossfade in place. Left in normal flow they both claim layout for the
 * duration of the swap, and the icons visibly squeeze apart and snap back.
 */
export function gsapPop(
  node: Element,
  params: { duration?: number; delay?: number; from?: number } = {},
): TransitionConfig {
  const durationSec = prefersReducedMotion() ? 0 : (params.duration ?? tokens.quick);
  const el = node as HTMLElement;
  const from = params.from ?? 0.7;
  return {
    duration: durationSec * 1000,
    delay: (params.delay ?? 0) * 1000,
    easing: easeOutExpo,
    tick: (t) => {
      el.style.opacity = String(t);
      el.style.transform = `scale(${from + (1 - from) * t})`;
    },
  };
}

/** Transform-only, so a row of them animating at once never touches layout. */
export function gsapRise(
  node: Element,
  params: { duration?: number; delay?: number } = {},
): TransitionConfig {
  const durationSec = prefersReducedMotion() ? 0 : (params.duration ?? tokens.smooth);
  const el = node as HTMLElement;
  return {
    duration: durationSec * 1000,
    delay: (params.delay ?? 0) * 1000,
    easing: easeOutExpo,
    tick: (t) => {
      el.style.opacity = String(Math.min(1, t * 2));
      el.style.transformOrigin = "bottom";
      el.style.transform = t >= 1 ? "" : `scaleY(${t})`;
    },
  };
}

/** Drop-in for svelte/transition's `slide`. */
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
      // A measured `height: …px` left on the element would leave a phantom gap
      // when its content later shrinks (e.g. an inner Collapsible closing).
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
