/**
 * Right-panel open/close timeline. Owns translateX on the panel and the
 * vignette opacity on the main area — coordinated via a single GSAP
 * timeline so they never desync.
 *
 * The grid-template-columns interpolation is left to a CSS `transition:`
 * on `.app-shell`; animating it via JS state writes thrashes Svelte's
 * reactivity on every frame and forces a full grid relayout. CSS handles
 * that cheaper.
 */
import { gsap } from "./gsap";
import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

interface PanelChoreographyArgs {
  panelEl: HTMLElement | null;
  mainEl: HTMLElement | null;
  open: boolean;
  /** Panel width at rest, in px. */
  panelWidth: number;
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
 * Returns a kill function. Safe to call when refs are null; snaps to the
 * resting state without animating.
 */
export function useRightPanelChoreography(args: PanelChoreographyArgs): () => void {
  const { panelEl, mainEl, open, panelWidth, snap } = args;
  const targetTranslateX = open ? 0 : panelWidth;
  const targetVignette = open ? VIGNETTE_OPEN : 0;

  if (snap || prefersReducedMotion()) {
    if (panelEl) gsap.set(panelEl, { x: targetTranslateX });
    if (mainEl) mainEl.style.setProperty(VIGNETTE_PROP, String(targetVignette));
    return () => {};
  }

  const duration = tokens.smooth;
  const ease = tokens.easeOutExpo;
  const vignetteProxy = { v: readVignette(mainEl) };
  const t = gsap.timeline();
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
