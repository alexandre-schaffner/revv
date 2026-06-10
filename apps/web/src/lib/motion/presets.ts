/**
 * Named GSAP timeline recipes for bits-ui content surfaces. Each returns a
 * Timeline so `bitsAnim` can drive it from `data-state` changes.
 *
 * If a new preset is needed, add it here — but only once a real callsite needs it.
 */
import { gsap } from "./gsap";
import { tokens } from "./tokens";

export type PresetFn<TOptions = void> = (el: Element, opts?: TOptions) => gsap.core.Timeline;

type Side = "top" | "right" | "bottom" | "left";

/**
 * Pop-in for a surface anchored to a trigger. The surface "grows out of" the
 * trigger by starting offset along its anchor axis: a top-side popover (trigger
 * BELOW) starts a few pixels lower and slides up; mirror on all four sides.
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
 * Backdrop fade for a dialog/sheet overlay. Timed to match `dialogSpringIn` /
 * `dialogSpringOut` (same durations + easings) so the scrim and the surface
 * move together instead of the scrim snapping in ahead of the spring.
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
