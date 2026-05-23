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

  const down = () => {
    if (current?.disabled) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    activeTween?.kill();
    activeTween = gsap.to(node, {
      scale: current?.scale ?? 0.97,
      duration: 0.06,
      ease: "power2.out",
    });
  };
  const up = () => {
    if (current?.disabled) return;
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
 * state becomes "open", `outPreset` when it becomes "closed". The "closed"
 * state usually disappears from the DOM almost immediately after the
 * attribute change; bits-ui's Presence primitive keeps the node mounted
 * long enough for the out-tween to run, but only when the element opts in
 * via `forceMount` and a presence prop. For elements that don't, the
 * out-tween is effectively a no-op (DOM removal happens first) — that's
 * fine for popover/tooltip where exits are imperceptible anyway.
 */
interface BitsAnimParams {
  inPreset: PresetFn<{ side?: "top" | "right" | "bottom" | "left" }>;
  outPreset?: PresetFn<{ side?: "top" | "right" | "bottom" | "left" }>;
  /** Read `data-side` and pass it to the preset for direction awareness. */
  directionAware?: boolean;
}

export const bitsAnim: Action<HTMLElement, BitsAnimParams> = (node, params) => {
  let current = params;
  let active: gsap.core.Timeline | null = null;

  const readSide = (): "top" | "right" | "bottom" | "left" | undefined => {
    if (!current?.directionAware) return undefined;
    const raw = node.getAttribute("data-side");
    if (raw === "top" || raw === "right" || raw === "bottom" || raw === "left")
      return raw;
    return undefined;
  };

  const play = (state: string | null) => {
    if (!current) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    active?.kill();
    const side = readSide();
    const opts = side ? { side } : {};
    if (state === "open") {
      active = current.inPreset(node, opts);
    } else if (state === "closed" && current.outPreset) {
      active = current.outPreset(node, opts);
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
      active?.kill();
    },
  };
};

/* ───────────────────────── re-exports for ergonomics ───────────────────────── */

export { popoverPopIn, popoverPopOut };
