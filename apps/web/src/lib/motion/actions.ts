/**
 * Svelte 5 use-directives.
 *
 *   <button use:gsapPress>           — press-down scale feedback
 *   <li use:gsapHover={{ prop }}>    — eases a 0–1 CSS variable on hover/focus
 *   <div use:bitsAnim={{ inPreset }}> — drives a bits-ui content surface from
 *                                       its data-state attribute
 *   <div use:heroMorph>              — scroll-driven big-hero → sidebar-hero
 *                                       crossfade for the recap detail layout
 */
import type { Action } from "svelte/action";

import { gsap } from "./gsap";
import type { PresetFn } from "./presets";
import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

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

/* ───────────────────────── gsapHover ───────────────────────── */

interface GsapHoverParams {
  /** A custom property the element's CSS reads as a 0–1 amount, e.g. `--lift`. */
  prop: `--${string}`;
}

/**
 * Eases `prop` to 1 while the pointer is over the element or focus is inside
 * it, and back to 0 after. The CSS decides what the amount means, so one
 * action serves any hover that is a matter of degree. Keep what it drives
 * on the compositor (opacity, `translate`): an amount that drives a blur
 * radius or a border colour repaints every frame and stutters.
 *
 * It never writes `transform` itself, so a hover can't fight a layout
 * animation running on the same element. Settles faster than it rises, the
 * way an exit should. Under reduced motion the state still changes, just
 * without the ease.
 */
export const gsapHover: Action<HTMLElement, GsapHoverParams> = (node, params) => {
  let current = params;
  let tween: gsap.core.Tween | null = null;
  let pointer = false;
  let focus = false;

  const sync = () => {
    const on = pointer || focus;
    tween?.kill();
    if (prefersReducedMotion()) {
      gsap.set(node, { [current.prop]: on ? 1 : 0 });
      return;
    }
    tween = gsap.to(node, {
      [current.prop]: on ? 1 : 0,
      duration: on ? tokens.smooth : tokens.quick,
      ease: on ? tokens.easeOutQuart : tokens.easeSoft,
    });
  };
  const enter = () => {
    pointer = true;
    sync();
  };
  const leave = () => {
    pointer = false;
    sync();
  };
  const focusIn = () => {
    focus = node.matches(":has(:focus-visible)");
    sync();
  };
  const focusOut = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
    focus = false;
    sync();
  };

  node.addEventListener("pointerenter", enter);
  node.addEventListener("pointerleave", leave);
  node.addEventListener("focusin", focusIn);
  node.addEventListener("focusout", focusOut);

  return {
    update(next: GsapHoverParams) {
      current = next;
    },
    destroy() {
      tween?.kill();
      node.removeEventListener("pointerenter", enter);
      node.removeEventListener("pointerleave", leave);
      node.removeEventListener("focusin", focusIn);
      node.removeEventListener("focusout", focusOut);
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

    const preset = isOpen ? current.inPreset : current.outPreset;
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

/* ───────────────────────── heroMorph ───────────────────────── */

interface HeroMorphParams {
  /** Selector for the sidebar element whose `inert` attribute mirrors visibility. */
  sidebarSelector?: string;
  /** Scroll distance (px) before the morph starts ramping. */
  startPx?: number;
  /** Scroll distance (px) over which `--shrink` ramps 0 → 1. */
  rangePx?: number;
}

const HERO_MORPH_DEFAULTS = {
  sidebarSelector: ".side",
  startPx: 160,
  rangePx: 120,
} as const;

function findScrollContainer(el: HTMLElement): HTMLElement | Window {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur;
    cur = cur.parentElement;
  }
  return window;
}

export const heroMorph: Action<HTMLElement, HeroMorphParams | undefined> = (node, params) => {
  const cfg = { ...HERO_MORPH_DEFAULTS, ...params };
  // Reduced motion suppresses the *ramp*, not the state: `--shrink` snaps
  // 0 → 1 at the midpoint instead of tweening. Pinning it to 1 (what this
  // used to do) leaves the sidebar fully opaque at scroll top, so the header
  // renders twice. The global reduced-motion block in app.css already
  // collapses the opacity transition, so there is nothing else to do here.
  const snap = prefersReducedMotion();

  // No viewport gate. Whether the sidebar has room is a question about the
  // AppShell main pane, not the window, and RecapDetail answers it with an
  // `@container` band that hides the rail outright — at which point `--shrink`
  // is inert and this listener costs one clamp per scroll event.
  const target = findScrollContainer(node);
  // Cache the sidebar reference; `null` until the recap hydrates, the
  // fallback inside onScroll picks it up on the next tick.
  let sidebar = node.querySelector<HTMLElement>(cfg.sidebarSelector);
  let lastInert: boolean | null = null;

  const onScroll = (): void => {
    const top = target instanceof Window ? window.scrollY : target.scrollTop;
    const ramp = Math.min(1, Math.max(0, (top - cfg.startPx) / cfg.rangePx));
    const next = snap ? (ramp < 0.5 ? 0 : 1) : ramp;
    node.style.setProperty("--shrink", String(next));
    // Keep the sidebar out of the tab order / a11y tree while it's
    // visually hidden, so screen readers don't see duplicate hero content.
    if (!sidebar) sidebar = node.querySelector<HTMLElement>(cfg.sidebarSelector);
    if (sidebar) {
      const shouldInert = next < 0.1;
      if (shouldInert !== lastInert) {
        sidebar.toggleAttribute("inert", shouldInert);
        lastInert = shouldInert;
      }
    }
  };

  onScroll();
  target.addEventListener("scroll", onScroll, { passive: true });

  return {
    destroy() {
      target.removeEventListener("scroll", onScroll);
    },
  };
};
