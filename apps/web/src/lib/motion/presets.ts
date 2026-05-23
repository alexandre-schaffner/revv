/**
 * Named, parameterized motion recipes used across the app.
 *
 * Each preset returns a gsap.core.Timeline so callers can chain, attach
 * callbacks, or kill it on cleanup. Presets are pure with respect to the
 * element they receive — no shared mutable state.
 *
 * Reduced-motion handling is done at the action / call-site layer via
 * `withMotion`, not inside the preset, so a preset can also be used outside
 * a matchMedia context (e.g., manually driven from a test).
 *
 * `essential` flag on a preset is metadata only; consumers query it to
 * decide whether to opt the preset back in under reduced motion.
 */
import { gsap } from "./gsap";
import { tokens } from "./tokens";

type Timeline = gsap.core.Timeline;
type TimelineVars = gsap.TimelineVars;

export interface PresetMeta {
  essential?: boolean;
}

export type PresetFn<TOptions = void> = ((
  el: Element,
  opts?: TOptions,
) => Timeline) & PresetMeta;

function tl(vars?: TimelineVars): Timeline {
  return gsap.timeline(vars);
}

/* ───────────────────────── Entrances ───────────────────────── */

export const dialogSpringIn: PresetFn = (el) =>
  tl().fromTo(
    el,
    { autoAlpha: 0, scale: 0.96, y: 12 },
    { autoAlpha: 1, scale: 1, y: 0, duration: tokens.smooth, ease: tokens.easeOutExpo },
  );

export const dialogSpringOut: PresetFn = (el) =>
  tl().to(el, {
    autoAlpha: 0,
    scale: 0.98,
    y: 4,
    duration: tokens.quick,
    ease: tokens.easeSoft,
  });

export const popoverPopIn: PresetFn<{ side?: "top" | "right" | "bottom" | "left" }> = (
  el,
  opts,
) => {
  const side = opts?.side ?? "bottom";
  const axis = side === "left" || side === "right" ? "x" : "y";
  const offset = side === "top" || side === "left" ? -4 : 4;
  return tl().fromTo(
    el,
    { autoAlpha: 0, scale: 0.96, [axis]: offset },
    {
      autoAlpha: 1,
      scale: 1,
      [axis]: 0,
      duration: tokens.snap,
      ease: tokens.easeOutExpo,
    },
  );
};

export const popoverPopOut: PresetFn = (el) =>
  tl().to(el, {
    autoAlpha: 0,
    scale: 0.98,
    duration: tokens.instant,
    ease: tokens.easeSoft,
  });

export const tooltipPopIn: PresetFn<{ side?: "top" | "right" | "bottom" | "left" }> = (
  el,
  opts,
) => {
  const side = opts?.side ?? "top";
  const axis = side === "left" || side === "right" ? "x" : "y";
  const offset = side === "top" || side === "left" ? -4 : 4;
  return tl().fromTo(
    el,
    { autoAlpha: 0, scale: 0.92, [axis]: offset },
    {
      autoAlpha: 1,
      scale: 1,
      [axis]: 0,
      duration: tokens.snap,
      ease: tokens.easeOutExpo,
    },
  );
};

export const tooltipPopOut: PresetFn = (el) =>
  tl().to(el, {
    autoAlpha: 0,
    scale: 0.96,
    duration: tokens.instant,
    ease: tokens.easeSoft,
  });

/* ───────────────────────── Layout / panels ───────────────────────── */

export const panelSlideIn: PresetFn<{ from?: "right" | "left"; distance?: number }> = (
  el,
  opts,
) => {
  const from = opts?.from ?? "right";
  const distance = opts?.distance ?? 100;
  const sign = from === "right" ? 1 : -1;
  return tl().fromTo(
    el,
    { xPercent: sign * distance, autoAlpha: 0 },
    {
      xPercent: 0,
      autoAlpha: 1,
      duration: tokens.smooth,
      ease: tokens.easeOutExpo,
    },
  );
};

export const panelSlideOut: PresetFn<{ to?: "right" | "left"; distance?: number }> = (
  el,
  opts,
) => {
  const to = opts?.to ?? "right";
  const distance = opts?.distance ?? 100;
  const sign = to === "right" ? 1 : -1;
  return tl().to(el, {
    xPercent: sign * distance,
    autoAlpha: 0,
    duration: tokens.smooth,
    ease: tokens.easeSoft,
  });
};

/* ───────────────────────── Lists / staggers ───────────────────────── */

export const queueItemStream: PresetFn<{ children?: string }> = (el, opts) => {
  const targets = opts?.children
    ? (el as HTMLElement).querySelectorAll(opts.children)
    : (el as HTMLElement).children;
  return tl().fromTo(
    targets,
    { autoAlpha: 0, y: 6 },
    {
      autoAlpha: 1,
      y: 0,
      duration: tokens.quick,
      ease: tokens.easeOutExpo,
      stagger: tokens.stagger.default,
    },
  );
};

export const walkthroughBlockReveal: PresetFn = (el) =>
  tl().fromTo(
    el,
    { autoAlpha: 0, y: 8, scale: 0.99 },
    {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: tokens.smooth,
      ease: tokens.easeOutExpo,
    },
  );

export const phaseDotLight: PresetFn = (el) =>
  tl()
    .fromTo(
      el,
      { scale: 0.6, autoAlpha: 0.4 },
      {
        scale: 1,
        autoAlpha: 1,
        duration: tokens.quick,
        ease: tokens.easeOutExpo,
      },
    )
    .to(
      el,
      {
        scale: 1.15,
        duration: tokens.snap,
        ease: tokens.easeOutExpo,
        yoyo: true,
        repeat: 1,
      },
      ">-0.05",
    );

/* ───────────────────────── Indicators (looped) ───────────────────────── */

export const streamCursorBlink: PresetFn = (el) =>
  tl({ repeat: -1, yoyo: true }).to(el, {
    autoAlpha: 0,
    duration: tokens.smooth,
    ease: "none",
  });
streamCursorBlink.essential = true;

export const pulseMarker: PresetFn = (el) =>
  tl({ repeat: -1 }).fromTo(
    el,
    { boxShadow: "0 0 0 0 var(--color-marker-open-glow)" },
    {
      boxShadow: "0 0 0 4px transparent",
      duration: tokens.pulse,
      ease: tokens.easeSoft,
    },
  );

export const statusDotBreath: PresetFn = (el) =>
  tl({ repeat: -1, yoyo: true }).fromTo(
    el,
    { scale: 0.9, autoAlpha: 0.7 },
    {
      scale: 1.05,
      autoAlpha: 1,
      duration: tokens.pulse / 2,
      ease: tokens.easeSoft,
    },
  );

export const syncSpin: PresetFn = (el) =>
  tl({ repeat: -1 }).to(el, {
    rotation: 360,
    duration: 1,
    ease: "none",
    transformOrigin: "50% 50%",
  });
syncSpin.essential = true;

/* ───────────────────────── Micro-interactions ───────────────────────── */

export const cmdHintReveal: PresetFn = (el) =>
  tl().fromTo(
    (el as HTMLElement).querySelectorAll("[data-cmd-hint]"),
    { autoAlpha: 0, scale: 0.85, width: 0 },
    {
      autoAlpha: 0.55,
      scale: 1,
      width: "auto",
      duration: tokens.snap,
      ease: tokens.easeOutExpo,
      stagger: tokens.stagger.tight,
    },
  );

export const ratingCellSelect: PresetFn = (el) =>
  tl().fromTo(
    el,
    { scale: 0.94 },
    {
      scale: 1,
      duration: tokens.snap,
      ease: "back.out(1.7)",
    },
  );

export const prItemHover: PresetFn<{ enter?: boolean }> = (el, opts) =>
  tl().to(el, {
    backgroundColor:
      opts?.enter !== false ? "var(--color-bg-tertiary)" : "transparent",
    duration: tokens.snap,
    ease: tokens.easeSoft,
  });

export const pinIconReveal: PresetFn<{ visible?: boolean }> = (el, opts) =>
  tl().to(el, {
    autoAlpha: opts?.visible ? 1 : 0,
    duration: tokens.snap,
    ease: tokens.easeSoft,
  });

/* ───────────────────────── Decorative / page-transition primitives ───────────────────────── */

// Page-root enter — used by the default crossfade between routes. The element
// this runs on is the persistent main-content wrapper, so a y-translate would
// shift everything underneath (including chrome that shouldn't move). Keep it
// to autoAlpha only; the subjective "crossfade" comes from the brief
// opacity:0 frame between navigation and the tween completing.
export const pageEnter: PresetFn = (el) =>
  tl().fromTo(
    el,
    { autoAlpha: 0 },
    {
      autoAlpha: 1,
      duration: tokens.quick,
      ease: tokens.easeOutExpo,
    },
  );

export const pageExit: PresetFn = (el) =>
  tl().to(el, {
    autoAlpha: 0,
    y: -4,
    duration: tokens.quick,
    ease: tokens.easeSoft,
  });
