/**
 * Svelte 5 use-directives wrapping GSAP presets.
 *
 * All actions:
 * - Run inside `withMotion()` so prefers-reduced-motion gates them.
 * - Store the resulting Timeline and `.kill()` it on destroy.
 * - Are safe to apply to elements that may be removed from the DOM during
 *   an in-flight tween (kill is idempotent).
 *
 * Usage:
 *   <div use:gsapIn={{ preset: dialogSpringIn }}>…</div>
 *   <button use:gsapPress>Save</button>
 */
import type { Action } from "svelte/action";

import { withMotion } from "./match-media";
import {
  type PresetFn,
  popoverPopIn,
  popoverPopOut,
  prItemHover,
} from "./presets";
import { gsap } from "./gsap";

/* ───────────────────────── gsapIn ───────────────────────── */

interface GsapInParams<TOpts = unknown> {
  preset: PresetFn<TOpts>;
  opts?: TOpts;
  delay?: number;
  /** Skip the animation; jump to the end state immediately. */
  skip?: boolean;
}

export const gsapIn: Action<HTMLElement, GsapInParams> = (node, params) => {
  if (!params) return {};
  let cleanup: (() => void) | undefined;
  const essential = params.preset.essential ?? false;

  const run = (p: GsapInParams) => {
    cleanup?.();
    cleanup = withMotion(
      ({ reduceMotion }) => {
        if (p.skip || reduceMotion) {
          // Apply the preset's end state without tweening.
          const t = p.preset(node, p.opts as never);
          t.progress(1).pause();
          return () => t.kill();
        }
        const t = p.preset(node, p.opts as never);
        if (p.delay) t.delay(p.delay);
        return () => t.kill();
      },
      { essential },
    );
  };

  run(params);

  return {
    update(next: GsapInParams) {
      run(next);
    },
    destroy() {
      cleanup?.();
    },
  };
};

/* ───────────────────────── gsapPress ───────────────────────── */

interface GsapPressParams {
  scale?: number;
  /** Disable on this element (e.g., when button is :disabled). */
  disabled?: boolean;
}

export const gsapPress: Action<HTMLElement, GsapPressParams | undefined> = (
  node,
  params,
) => {
  let current: GsapPressParams | undefined = params;
  let activeTween: gsap.core.Tween | null = null;

  const shouldSkip = (): boolean => {
    if (current?.disabled) return true;
    // Mirror the existing CSS convention: buttons that open popovers /
    // menus / dialogs don't get press feedback — the opening surface IS
    // the feedback, and a competing scale animation reads as jitter.
    if (node.hasAttribute("aria-haspopup")) return true;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return true;
    return false;
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
      ease: "back.out(2)",
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

/* ───────────────────────── gsapHover ───────────────────────── */

interface GsapHoverParams<TOpts = unknown> {
  preset: PresetFn<TOpts>;
  optsEnter?: TOpts;
  optsLeave?: TOpts;
}

export const gsapHover: Action<HTMLElement, GsapHoverParams | undefined> = (
  node,
  params,
) => {
  let current = params;
  let active: gsap.core.Timeline | null = null;

  const enter = () => {
    if (!current) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    active?.kill();
    active = current.preset(node, current.optsEnter as never);
  };
  const leave = () => {
    if (!current) return;
    active?.kill();
    active = current.preset(node, current.optsLeave as never);
  };

  node.addEventListener("pointerenter", enter);
  node.addEventListener("pointerleave", leave);

  return {
    update(next) {
      current = next;
    },
    destroy() {
      active?.kill();
      node.removeEventListener("pointerenter", enter);
      node.removeEventListener("pointerleave", leave);
    },
  };
};

/* ───────────────────────── gsapPrItemHover (typed convenience) ───────────────────────── */

export const gsapPrHoverAction: Action<HTMLElement> = (node) => {
  const enter = () => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    prItemHover(node, { enter: true });
  };
  const leave = () => {
    prItemHover(node, { enter: false });
  };
  node.addEventListener("pointerenter", enter);
  node.addEventListener("pointerleave", leave);
  return {
    destroy() {
      node.removeEventListener("pointerenter", enter);
      node.removeEventListener("pointerleave", leave);
    },
  };
};

/* ───────────────────────── bitsAnim ───────────────────────── */

/**
 * Watches `data-state` on a bits-ui content element. Plays `inPreset` when
 * state becomes "open", `outPreset` when it becomes "closed".
 *
 * bits-ui v2's Presence layer uses `node.getAnimations()` + the Web Animations
 * API `animation.finished` promise to know when an exit is over and the node
 * can be unmounted. GSAP tweens are driven by requestAnimationFrame and do
 * NOT show up in `getAnimations()` — so a GSAP-only exit would race the
 * unmount and the user would see the element vanish without animation.
 *
 * The fix: while the GSAP exit runs, register a WAAPI placeholder animation
 * of equal duration that animates a no-op CSS custom property
 * (`--gsap-presence-frame`). bits-ui's `getAnimations()` sees it; its
 * `animation.finished` resolves when GSAP's `onComplete` fires `finish()`.
 * Visuals are 100% GSAP; the placeholder is purely a presence signal.
 */
type BitsSide = "top" | "right" | "bottom" | "left";

// Presets passed to bitsAnim may or may not be direction-aware. We allow
// either shape; direction-blind presets simply ignore the `side` opts the
// action passes them.
type BitsPreset = PresetFn<{ side?: BitsSide }> | PresetFn<void>;

interface BitsAnimParams {
  inPreset: BitsPreset;
  outPreset?: BitsPreset;
  /** Read `data-side` and pass it to the preset for direction awareness. */
  directionAware?: boolean;
  /** Override the placeholder WAAPI duration (seconds). Defaults to the
   *  preset's resolved timeline duration. */
  exitDuration?: number;
}

const PRESENCE_PROP = "--gsap-presence-frame";

function presencePlaceholder(node: HTMLElement, durationSec: number): Animation | null {
  if (typeof node.animate !== "function") return null;
  // Animate a custom property nothing else reads so we don't fight GSAP for
  // any visual property. fill:"forwards" so the animation stays "finished"
  // until we manually .cancel() or it's garbage-collected.
  return node.animate(
    [
      { [PRESENCE_PROP]: 0 } as unknown as Keyframe,
      { [PRESENCE_PROP]: 1 } as unknown as Keyframe,
    ],
    { duration: Math.max(0, durationSec * 1000), fill: "forwards" },
  );
}

export const bitsAnim: Action<HTMLElement, BitsAnimParams> = (node, params) => {
  let current = params;
  let active: gsap.core.Timeline | null = null;
  let placeholder: Animation | null = null;

  const readSide = (): BitsSide | undefined => {
    if (!current?.directionAware) return undefined;
    const raw = node.getAttribute("data-side");
    if (raw === "top" || raw === "right" || raw === "bottom" || raw === "left")
      return raw;
    return undefined;
  };

  const reduceMotion = (): boolean =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const killActive = () => {
    active?.kill();
    active = null;
    placeholder?.cancel();
    placeholder = null;
  };

  const play = (state: string | null) => {
    if (!current) return;
    killActive();
    const side = readSide();
    const opts = side ? { side } : {};

    if (state === "open" || state === "delayed-open" || state === "instant-open") {
      if (reduceMotion()) {
        // Apply end-state without tweening; bits-ui's getAnimations()-based
        // wait is a no-op when there are no animations.
        const tl = (current.inPreset as PresetFn<unknown>)(node, opts);
        tl.progress(1).pause();
        active = tl;
        return;
      }
      active = (current.inPreset as PresetFn<unknown>)(node, opts);
      return;
    }

    if (state === "closed" && current.outPreset) {
      if (reduceMotion()) {
        const tl = (current.outPreset as PresetFn<unknown>)(node, opts);
        tl.progress(1).pause();
        active = tl;
        return;
      }
      active = (current.outPreset as PresetFn<unknown>)(node, opts);
      const dur = current.exitDuration ?? active.duration();
      placeholder = presencePlaceholder(node, dur);
      active.eventCallback("onComplete", () => {
        placeholder?.finish();
      });
      return;
    }
  };

  // Fire once on mount with the current state.
  play(node.getAttribute("data-state"));

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.attributeName === "data-state") {
        play(node.getAttribute("data-state"));
      }
    }
  });
  observer.observe(node, {
    attributes: true,
    attributeFilter: ["data-state"],
  });

  return {
    update(next) {
      current = next;
    },
    destroy() {
      observer.disconnect();
      killActive();
    },
  };
};

/* ───────────────────────── re-exports for ergonomics ───────────────────────── */

export { popoverPopIn, popoverPopOut };
