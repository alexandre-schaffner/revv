import type { Action } from "svelte/action";

import { gsap } from "./gsap";
import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

export interface EnterParams {
  /** Rise from this many px below (negative: drop from above). */
  readonly y?: number;
  /** Start from this scale. */
  readonly scale?: number;
  /** Start blurred by this many px. */
  readonly blur?: number;
  /** Fade in from transparent. Default true. */
  readonly fade?: boolean;
  /** Seconds. Default `tokens.ceremonialMedium`. */
  readonly duration?: number;
  /** Seconds; the element stays at its start state until then. */
  readonly delay?: number;
}

/**
 * A one-shot entrance, played when the element mounts: from the given offset,
 * scale, blur and transparency to the element's own style, on
 * `--ease-out-expo`. Later parameter changes don't replay it. Under reduced
 * motion the element simply appears.
 */
export const gsapEnter: Action<HTMLElement, EnterParams | undefined> = (node, params = {}) => {
  if (prefersReducedMotion()) return;
  const { y, scale, blur, fade = true, duration = tokens.ceremonialMedium, delay = 0 } = params;
  const from: gsap.TweenVars = {};
  const cleared: string[] = [];
  if (fade) {
    from.opacity = 0;
    cleared.push("opacity");
  }
  if (y !== undefined || scale !== undefined) {
    if (y !== undefined) from.y = y;
    if (scale !== undefined) from.scale = scale;
    cleared.push("transform");
  }
  if (blur !== undefined) {
    from.filter = `blur(${blur}px)`;
    cleared.push("filter");
  }
  const tween = gsap.from(node, {
    ...from,
    duration,
    delay,
    ease: tokens.easeOutExpo,
    // A leftover inline transform would keep the element a containing block
    // for its `position: fixed` descendants.
    clearProps: cleared.join(","),
  });
  return {
    destroy() {
      tween.kill();
    },
  };
};
