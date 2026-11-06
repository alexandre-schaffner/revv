import type { Action } from "svelte/action";

import { gsap } from "./gsap";
import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

/**
 * Turns the element to `deg`: set on mount, tweened on every later change.
 * GSAP owns the element's rotation, so it must carry no CSS `rotate` of its
 * own (a tween would clobber it).
 */
export const gsapRotate: Action<HTMLElement, number> = (node, deg) => {
  let tween: gsap.core.Tween | null = null;
  gsap.set(node, { rotation: deg });

  return {
    update(next: number) {
      tween?.kill();
      if (prefersReducedMotion()) {
        gsap.set(node, { rotation: next });
        return;
      }
      tween = gsap.to(node, { rotation: next, duration: tokens.snap, ease: tokens.easeSoft });
    },
    destroy() {
      tween?.kill();
    },
  };
};
