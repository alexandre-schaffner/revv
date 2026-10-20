import { prefersReducedMotion } from "./reduced-motion";

let crossfading = false;
/** Bumped by every crossfade, so only the latest of overlapping ones cleans up. */
let generation = 0;

/** On <html> for the length of a crossfade: retimes the fade and freezes glass (app.css). */
const CROSSFADE = "document-crossfade";

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
 * Freeze the page's glass to solid fills. A glass surface is marked with
 * `data-glass`, on the element that carries the backdrop filter, so finding
 * them is one query rather than a walk of every stylesheet. `before` runs
 * between reading and writing: anything that invalidates styles (the
 * crossfade's root class) has to come after the reads, or the first read
 * pays for a whole-document recalc inside the click.
 */
function freezeGlass(before?: () => void): void {
  const page = getComputedStyle(document.body).backgroundColor;
  const glass: [HTMLElement, string][] = [];
  for (const el of document.querySelectorAll<HTMLElement>("[data-glass]")) {
    // Marked glass whose blur a caller took away (a dialog with its own chrome) stays as it is.
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
  const mine = ++generation;
  // A crossfade still running is skipped by this one. Its frozen glass would
  // read back as the fill it was frozen to, so thaw it before reading.
  if (crossfading) {
    thawGlass();
    root.classList.remove(CROSSFADE);
  }
  crossfading = true;
  freezeGlass(() => root.classList.add(CROSSFADE));
  try {
    await document.startViewTransition(async () => {
      await update();
      if (mine !== generation) return;
      // The new page's glass, in the new colours: thaw to read them, refreeze.
      thawGlass();
      freezeGlass();
    }).finished;
  } catch {
    // Skipped by a newer transition, or the update threw — either way the
    // page is in its new state; there's nothing left to fade.
  } finally {
    // Only the latest crossfade puts the page back: one it skipped settles
    // while the latest is still fading, with its glass still frozen.
    if (mine === generation) {
      thawGlass();
      crossfading = false;
      root.classList.remove(CROSSFADE);
    }
  }
}
