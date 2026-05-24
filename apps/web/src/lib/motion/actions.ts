/**
 * Svelte 5 use-directives. Two actions, both GSAP-driven:
 *
 *   <button use:gsapPress>           — press-down scale feedback
 *   <div use:bitsAnim={{ inPreset }}> — drives a bits-ui content surface from
 *                                       its data-state attribute
 */
import type { Action } from "svelte/action";

import { gsap } from "./gsap";
import type { PresetFn } from "./presets";
import { prefersReducedMotion } from "./reduced-motion";

/* ───────────────────────── gsapPress ───────────────────────── */

interface GsapPressParams {
  scale?: number;
  /** Skip the press effect (e.g., when the button is :disabled). */
  disabled?: boolean;
}

export const gsapPress: Action<HTMLElement, GsapPressParams | undefined> = (node, params) => {
  let current: GsapPressParams | undefined = params;
  let activeTween: gsap.core.Tween | null = null;

  const shouldSkip = (): boolean => {
    if (current?.disabled) return true;
    // Triggers that open a popover/menu/dialog rely on the surface itself as
    // feedback; a competing press scale reads as jitter.
    if (node.hasAttribute("aria-haspopup")) return true;
    return prefersReducedMotion();
  };

  const down = () => {
    if (shouldSkip()) return;
    activeTween?.kill();
    activeTween = gsap.to(node, {
      scale: current?.scale ?? 0.97,
      duration: 0.06,
      ease: "power2.out",
    });
  };
  const up = () => {
    if (shouldSkip()) return;
    activeTween?.kill();
    activeTween = gsap.to(node, {
      scale: 1,
      duration: 0.14,
      ease: "power3.out",
    });
  };

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointerleave", up);
  node.addEventListener("pointercancel", up);

  return {
    update(next: GsapPressParams | undefined) {
      current = next;
    },
    destroy() {
      activeTween?.kill();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointerleave", up);
      node.removeEventListener("pointercancel", up);
    },
  };
};

/* ───────────────────────── bitsAnim ───────────────────────── */

/**
 * Plays `inPreset` when the host element's `data-state` becomes "open" and
 * `outPreset` when it becomes "closed".
 *
 * The WAAPI placeholder. bits-ui v2's Presence layer calls
 * `node.getAnimations()` and awaits `animation.finished` to decide when an
 * exit is done and the node can unmount. GSAP runs on rAF and does NOT register
 * with the Web Animations API, so a pure-GSAP exit would race the unmount and
 * the element would vanish without animating. We register a no-op WAAPI
 * animation on a custom property (`--gsap-presence-frame`) for the duration of
 * the exit; bits-ui's `getAnimations()` sees it, and we resolve it from GSAP's
 * onComplete. If bits-ui changes its presence detection
 * (https://github.com/huntabyte/bits-ui — `src/lib/bits/utilities/presence`),
 * this needs to be revisited.
 */
type Side = "top" | "right" | "bottom" | "left";
type BitsPreset = PresetFn<{ side?: Side }> | PresetFn<void>;

interface BitsAnimParams {
  inPreset: BitsPreset;
  outPreset?: BitsPreset;
  /** Read `data-side` and pass it to the preset. */
  directionAware?: boolean;
}

const PRESENCE_PROP = "--gsap-presence-frame";

function presencePlaceholder(node: HTMLElement, durationSec: number): Animation | null {
  if (typeof node.animate !== "function") return null;
  return node.animate(
    [{ [PRESENCE_PROP]: 0 } as unknown as Keyframe, { [PRESENCE_PROP]: 1 } as unknown as Keyframe],
    { duration: Math.max(0, durationSec * 1000), fill: "forwards" },
  );
}

export const bitsAnim: Action<HTMLElement, BitsAnimParams> = (node, params) => {
  let current = params;
  let active: gsap.core.Timeline | null = null;
  let placeholder: Animation | null = null;

  const readSide = (): Side | undefined => {
    if (!current?.directionAware) return undefined;
    const raw = node.getAttribute("data-side");
    return raw === "top" || raw === "right" || raw === "bottom" || raw === "left" ? raw : undefined;
  };

  const stop = () => {
    active?.kill();
    active = null;
    placeholder?.cancel();
    placeholder = null;
  };

  const play = (state: string | null) => {
    if (!current) return;
    stop();
    const side = readSide();
    const opts = side ? { side } : {};
    const isOpen = state === "open" || state === "delayed-open" || state === "instant-open";
    const isClosed = state === "closed" && current.outPreset;

    if (!isOpen && !isClosed) return;

    const preset = isOpen ? current.inPreset : current.outPreset!;
    active = (preset as PresetFn<unknown>)(node, opts);

    if (prefersReducedMotion()) {
      active.progress(1).pause();
      return;
    }

    if (isClosed) {
      placeholder = presencePlaceholder(node, active.duration());
      active.eventCallback("onComplete", () => placeholder?.finish());
    }
  };

  play(node.getAttribute("data-state"));

  const observer = new MutationObserver(() => {
    play(node.getAttribute("data-state"));
  });
  observer.observe(node, { attributes: true, attributeFilter: ["data-state"] });

  return {
    update(next) {
      current = next;
    },
    destroy() {
      observer.disconnect();
      stop();
    },
  };
};
