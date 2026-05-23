/**
 * Central GSAP initialization. The ONLY module that imports `gsap` from the
 * package; everything else imports from `$lib/motion`.
 *
 * Imported eagerly from `+layout.svelte` so plugins are registered before
 * any preset / action runs.
 */
import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";

let initialized = false;

export function initGsap(): void {
  if (initialized) return;
  initialized = true;
  // CustomEase parses the bare cubic-bezier strings in `tokens.ts`. Without
  // it, an ease like "0.16, 1, 0.3, 1" silently falls back to power1.out.
  gsap.registerPlugin(CustomEase);
  // overwrite:auto lets a fresh tween cancel any in-flight tween on the same
  // target+property — important wherever state can toggle faster than the
  // tween completes (rapid panel open/close, tab switches).
  gsap.defaults({ overwrite: "auto" });
}

export { gsap };
