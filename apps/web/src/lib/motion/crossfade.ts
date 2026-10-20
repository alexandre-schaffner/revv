import { prefersReducedMotion } from "./reduced-motion";

let crossfading = false;

/** Whether a whole-document crossfade is mid-flight. */
export function isDocumentCrossfading(): boolean {
  return crossfading;
}

// ── Glass ────────────────────────────────────────────────────────────────
//
// `backdrop-filter` blurs whatever is painted behind an element. Inside a
// View Transition snapshot the engine may hand it nothing to blur, and glass
// goes transparent for the length of the fade. So for the fade only, each
// glass surface trades its live blur for a solid fill: its own tint laid over
// the page background, which is roughly what the blur shows anyway. Both
// snapshots then hold a plain opaque surface that crossfades cleanly.

const FROZEN = "glass-frozen";

let probe: CanvasRenderingContext2D | null = null;

/** `color` composited over `under`, as an opaque `rgb()`. Canvas parses any CSS colour syntax. */
function solidOver(color: string, under: string): string {
  if (!probe) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!probe) return under;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = under;
  probe.fillRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  return `rgb(${r} ${g} ${b})`;
}

/**
 * Selectors of every style rule that sets a backdrop filter. Walking the
 * stylesheets is a few milliseconds; reading the computed style of every
 * element on a busy route was ~80ms, all of it inside the click.
 */
function glassSelectors(): string[] {
  const found = new Set<string>();
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const style = rule.style;
        const filter = style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter");
        if (filter && filter !== "none") found.add(rule.selectorText);
      }
      // Grouping rules (@media, @layer, @supports) and nested style rules.
      if ("cssRules" in rule && rule.cssRules) walk(rule.cssRules as CSSRuleList);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A cross-origin sheet; nothing of ours.
    }
  }
  return [...found];
}

function glassElements(): HTMLElement[] {
  const elements = new Set<HTMLElement>();
  for (const selector of glassSelectors()) {
    try {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) elements.add(el);
    } catch {
      // A selector querySelectorAll can't take (a pseudo-element); skip it.
    }
  }
  for (const el of document.querySelectorAll<HTMLElement>("[style*='backdrop-filter']")) {
    elements.add(el);
  }
  return [...elements];
}

/**
 * Freeze the page's glass to solid fills. `before` runs between reading and
 * writing: anything that invalidates styles (the crossfade's root class) has
 * to come after the reads, or the first read pays for a whole-document
 * recalc inside the click.
 */
function freezeGlass(before?: () => void): void {
  const page = getComputedStyle(document.body).backgroundColor;
  const glass: [HTMLElement, string][] = [];
  for (const el of glassElements()) {
    // The rule matched; the cascade may still have overridden it.
    const style = getComputedStyle(el);
    const filter = style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter");
    if (filter && filter !== "none") glass.push([el, style.backgroundColor]);
  }
  // Read everything, then write, so the scan costs one style recalc.
  before?.();
  for (const [el, background] of glass) {
    el.style.setProperty("--glass-fill", solidOver(background, page));
    el.classList.add(FROZEN);
  }
}

function thawGlass(): void {
  for (const el of document.querySelectorAll<HTMLElement>(`.${FROZEN}`)) {
    el.classList.remove(FROZEN);
    el.style.removeProperty("--glass-fill");
  }
}

/**
 * Crossfade the whole document from its current rendering to whatever
 * `update` produces, over `--duration-ceremonial-medium`.
 *
 * Built on a root View Transition: the browser snapshots the page as one
 * image, runs `update`, and fades the old image out over the live new page.
 * That's the only way a change that touches everything (a theme switch) can
 * fade as one piece: canvases, shadow DOM and iframes are part of the
 * snapshot, so nothing cuts ahead of the rest, and it's one composited layer
 * rather than thousands of per-element transitions. Glass surfaces are
 * frozen to solid fills for the length of the fade (see above).
 *
 * Components with motion of their own for the same change (the repo hero's
 * sky) should check {@link isDocumentCrossfading} and swap instantly, or the
 * change plays twice. Under reduced motion, where View Transitions aren't
 * supported, or while the window is hidden (the engine would skip the
 * transition anyway), `update` simply runs.
 */
export async function crossfadeDocument(update: () => void | Promise<void>): Promise<void> {
  if (
    prefersReducedMotion() ||
    typeof document.startViewTransition !== "function" ||
    document.visibilityState !== "visible"
  ) {
    await update();
    return;
  }
  const root = document.documentElement;
  crossfading = true;
  freezeGlass(() => root.classList.add("document-crossfade"));
  try {
    await document.startViewTransition(async () => {
      await update();
      // The new page's glass, in the new colours: thaw to read them, refreeze.
      thawGlass();
      freezeGlass();
    }).finished;
  } catch {
    // Skipped by a newer transition, or the update threw — either way the
    // page is in its new state; there's nothing left to fade.
  } finally {
    thawGlass();
    crossfading = false;
    root.classList.remove("document-crossfade");
  }
}
