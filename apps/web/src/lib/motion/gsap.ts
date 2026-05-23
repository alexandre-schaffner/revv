/**
 * Central GSAP initialization for Revv.
 *
 * This is the ONLY module that imports `gsap` from the package. Everything
 * else in the app should import from `$lib/motion/{presets,actions,...}`.
 * That keeps tree-shaking and any future plugin swaps in one place.
 *
 * Imported eagerly from +layout.svelte so plugins are registered before any
 * preset / action runs. Registration is idempotent — calling registerPlugin
 * twice with the same plugin is a no-op.
 */
import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { Draggable } from "gsap/Draggable";
import { Flip } from "gsap/Flip";
import { Observer } from "gsap/Observer";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import { tokens } from "./tokens";

let initialized = false;

export function initGsap(): void {
  if (initialized) return;
  initialized = true;

  // CustomEase is free in GSAP v3. We register it because the motion tokens
  // store eases as bare cubic-bezier control points (e.g. "0.16, 1, 0.3, 1")
  // and GSAP's _configEaseFromString defers any string starting with a digit
  // or dot to CustomEase — without it, those tokens would silently fall back
  // to the global default and every animation would use power1.out.
  gsap.registerPlugin(CustomEase, Flip, Observer, Draggable, ScrollTrigger);

  // Project-wide defaults. Individual tweens / timelines can override.
  // `overwrite: "auto"` lets a fresh tween cleanly cancel any active tween
  // of the same target on the same properties — important when state
  // toggles faster than the previous tween could complete (rapid panel
  // open/close, repeated tab switches).
  gsap.defaults({
    duration: tokens.quick,
    ease: tokens.easeOutExpo,
    overwrite: "auto",
  });
}

export { gsap, CustomEase, Flip, Observer, Draggable, ScrollTrigger };
