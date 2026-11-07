/**
 * The ONLY module that imports `gsap` from the package; everything else
 * imports from `$lib/motion`. `+layout.svelte` calls `initGsap()` before any
 * preset or action runs.
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
  // overwrite:auto makes a fresh tween cancel any in-flight tween on the same
  // target+property, for state that toggles faster than a tween completes.
  gsap.defaults({ overwrite: "auto" });
}

export { gsap };
