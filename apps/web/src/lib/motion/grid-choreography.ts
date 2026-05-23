/**
 * GSAP helpers for the AppShell grid: the sidebar/right-panel column tracks
 * and the right-panel's coordinated slide + vignette crossfade.
 *
 * These functions take refs and return imperative tween handles so the
 * caller (`AppShell.svelte`) can stay declarative and concise.
 */
import { gsap } from "./gsap";
import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

interface TrackTweenOptions {
  duration?: number;
  ease?: string;
}

/**
 * Tween a numeric "track px" proxy toward `target`. The caller owns the
 * reactive state cell — this function writes to it on every frame via the
 * `setPx` callback. Returns a kill function suitable for `$effect` teardown.
 *
 * Snap (no tween) when:
 *   - `snap` returns true (live drag, virtualized tree, etc.)
 *   - reduced motion is active
 */
export function tweenGridTrack(
  currentPx: number,
  target: number,
  setPx: (next: number) => void,
  opts: { snap?: boolean } & TrackTweenOptions = {},
): () => void {
  if (opts.snap || prefersReducedMotion()) {
    setPx(target);
    return () => {};
  }
  const proxy = { v: currentPx };
  const tween = gsap.to(proxy, {
    v: target,
    duration: opts.duration ?? tokens.smooth,
    ease: opts.ease ?? tokens.easeOutExpo,
    onUpdate() {
      setPx(proxy.v);
    },
  });
  return () => tween.kill();
}

interface PanelChoreographyArgs {
  panelEl: HTMLElement | null;
  mainEl: HTMLElement | null;
  /** Panel open state. Triggers all three sub-tweens. */
  open: boolean;
  /** Panel width at rest, in px. */
  panelWidth: number;
  /** Current track-px value (the proxy state cell the caller owns). */
  trackPx: number;
  /** Setter for the track-px state cell. */
  setTrackPx: (next: number) => void;
  /** Snap (no tween): live drag, first paint. */
  snap: boolean;
}

const VIGNETTE_OPEN = 0.65;
const VIGNETTE_PROP = "--vignette-opacity";

function readVignette(mainEl: HTMLElement | null): number {
  if (!mainEl) return 0;
  const raw = mainEl.style.getPropertyValue(VIGNETTE_PROP);
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Coordinated tween for the right-panel open/close: grid-column track,
 * panel translateX, and the main-area's vignette opacity, all on one
 * timeline so they never desync.
 *
 * Returns a kill function. Safe to call when refs are null; snaps to the
 * resting state without animating.
 */
export function useRightPanelChoreography(args: PanelChoreographyArgs): () => void {
  const { panelEl, mainEl, open, panelWidth, trackPx, setTrackPx, snap } = args;
  const targetTrack = open ? panelWidth : 0;
  const targetTranslateX = open ? 0 : panelWidth;
  const targetVignette = open ? VIGNETTE_OPEN : 0;

  if (snap || prefersReducedMotion()) {
    setTrackPx(targetTrack);
    if (panelEl) gsap.set(panelEl, { x: targetTranslateX });
    if (mainEl) mainEl.style.setProperty(VIGNETTE_PROP, String(targetVignette));
    return () => {};
  }

  // Asymmetric timing: open ~smooth so the panel lands deliberately; close at
  // ~quick because the user already decided to dismiss. ~73% ratio.
  const duration = open ? tokens.smooth : tokens.quick;
  const ease = open ? tokens.easeOutExpo : tokens.easeSoft;
  const trackProxy = { v: trackPx };
  const vignetteProxy = { v: readVignette(mainEl) };
  const t = gsap.timeline();
  t.to(
    trackProxy,
    {
      v: targetTrack,
      duration,
      ease,
      onUpdate() {
        setTrackPx(trackProxy.v);
      },
    },
    0,
  );
  if (panelEl) {
    t.to(panelEl, { x: targetTranslateX, duration, ease }, 0);
  }
  if (mainEl) {
    t.to(
      vignetteProxy,
      {
        v: targetVignette,
        duration,
        ease,
        onUpdate() {
          mainEl.style.setProperty(VIGNETTE_PROP, String(vignetteProxy.v));
        },
      },
      0,
    );
  }
  return () => t.kill();
}
