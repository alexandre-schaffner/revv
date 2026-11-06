/**
 * GSAP timeline recipes for bits-ui content surfaces. Each returns a Timeline
 * so `bitsAnim` can drive it from `data-state` changes.
 */
import { gsap } from "./gsap";
import { tokens } from "./tokens";

export type PresetFn<TOptions = void> = (el: Element, opts?: TOptions) => gsap.core.Timeline;

type Side = "top" | "right" | "bottom" | "left";

/**
 * The surface grows out of its trigger: a `top`-side popover (trigger below
 * it) starts a few pixels lower and slides up, mirrored on all four sides.
 */
function popInFromSide(el: Element, side: Side, fromScale: number): gsap.core.Timeline {
  const axis = side === "left" || side === "right" ? "x" : "y";
  const offset = side === "top" || side === "left" ? 4 : -4;
  return gsap.timeline().fromTo(
    el,
    { autoAlpha: 0, scale: fromScale, [axis]: offset },
    {
      autoAlpha: 1,
      scale: 1,
      [axis]: 0,
      duration: tokens.snap,
      ease: tokens.easeOutExpo,
    },
  );
}

export const dialogSpringIn: PresetFn = (el) =>
  gsap
    .timeline()
    .fromTo(
      el,
      { autoAlpha: 0, scale: 0.96, y: 12 },
      { autoAlpha: 1, scale: 1, y: 0, duration: tokens.smooth, ease: tokens.easeOutExpo },
    );

export const dialogSpringOut: PresetFn = (el) =>
  gsap.timeline().to(el, {
    autoAlpha: 0,
    scale: 0.98,
    y: 4,
    duration: tokens.quick,
    ease: tokens.easeSoft,
  });

/**
 * Same durations and easings as `dialogSpringIn` / `dialogSpringOut`, so the
 * scrim and the surface move together.
 */
export const overlayFadeIn: PresetFn = (el) =>
  gsap
    .timeline()
    .fromTo(
      el,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: tokens.smooth, ease: tokens.easeOutExpo },
    );

export const overlayFadeOut: PresetFn = (el) =>
  gsap.timeline().to(el, { autoAlpha: 0, duration: tokens.quick, ease: tokens.easeSoft });

export const popoverPopIn: PresetFn<{ side?: Side }> = (el, opts) =>
  popInFromSide(el, opts?.side ?? "bottom", 0.96);

export const popoverPopOut: PresetFn = (el) =>
  gsap.timeline().to(el, {
    autoAlpha: 0,
    scale: 0.98,
    duration: tokens.instant,
    ease: tokens.easeSoft,
  });

export const tooltipPopIn: PresetFn<{ side?: Side }> = (el, opts) =>
  popInFromSide(el, opts?.side ?? "top", 0.92);

export const tooltipPopOut: PresetFn = (el) =>
  gsap.timeline().to(el, {
    autoAlpha: 0,
    scale: 0.96,
    duration: tokens.instant,
    ease: tokens.easeSoft,
  });

export const collapsibleOpen: PresetFn = (el) =>
  gsap
    .timeline()
    .fromTo(
      el,
      { height: 0 },
      { height: "auto", duration: tokens.quick, ease: tokens.easeOutExpo, clearProps: "height" },
    );

export const collapsibleClose: PresetFn = (el) =>
  gsap.timeline().to(el, { height: 0, duration: tokens.quick, ease: tokens.easeOutExpo });

/**
 * Background-tint pulse on a settings row that search just landed on. Tweens
 * `--setting-flash` (0 → 1 → 0); the row's CSS turns it into an accent tint, so
 * the color stays a theme token instead of a value GSAP has to parse. Callers
 * skip it entirely under reduced motion — the scroll alone marks the row.
 */
export const settingFlash: PresetFn = (el) =>
  gsap
    .timeline()
    .fromTo(
      el,
      { "--setting-flash": 0 },
      { "--setting-flash": 1, duration: tokens.quick, ease: tokens.easeOutExpo },
    )
    .to(el, { "--setting-flash": 0, duration: tokens.pulse, ease: tokens.easeSoft });
