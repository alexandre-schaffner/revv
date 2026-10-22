import { afterPaint } from "./frames";
import { gsap } from "./gsap";
import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

/** The crossfade holding the page (root class, frozen glass). A newer one takes it over. */
let holder: symbol | null = null;

const CROSSFADE = "document-crossfade";

// `backdrop-filter` blurs whatever is painted behind an element. Inside a
// View Transition snapshot the engine may hand it nothing to blur, and glass
// goes transparent for the length of the fade.
const FROZEN = "glass-frozen";

let probe: CanvasRenderingContext2D | null = null;

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

interface GlassReading {
  readonly page: string;
  readonly surfaces: readonly (readonly [HTMLElement, string])[];
}

function readGlass(): GlassReading {
  const page = getComputedStyle(document.body).backgroundColor;
  const surfaces: [HTMLElement, string][] = [];
  for (const el of document.querySelectorAll<HTMLElement>("[data-glass]")) {
    const style = getComputedStyle(el);
    const filter = style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter");
    if (filter && filter !== "none") surfaces.push([el, style.backgroundColor]);
  }
  return { page, surfaces };
}

function freezeGlass({ page, surfaces }: GlassReading): void {
  for (const [el, background] of surfaces) {
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

function releasePage(): void {
  thawGlass();
  document.documentElement.classList.remove(CROSSFADE);
}

export async function crossfadeDocument(update: () => void | Promise<void>): Promise<void> {
  if (
    prefersReducedMotion() ||
    typeof document.startViewTransition !== "function" ||
    document.visibilityState !== "visible"
  ) {
    await update();
    return;
  }
  const me = Symbol("crossfade");
  if (holder) releasePage();
  holder = me;
  const glass = readGlass();
  document.documentElement.classList.add(CROSSFADE);
  freezeGlass(glass);
  try {
    await document.startViewTransition(async () => {
      await update();
      if (holder !== me) return;
      thawGlass();
      freezeGlass(readGlass());
    }).finished;
  } finally {
    if (holder === me) {
      releasePage();
      holder = null;
    }
  }
}

type Look = Readonly<Record<string, string | number>>;

/** A look change on its way in. */
interface Turn {
  /** Put the end state up now, started or not. Idempotent. */
  land(): void;
}

/**
 * Turn `target` to `to` after the next paint, at the pace the document crossfade runs at
 * (`ceremonialMedium`, `easeSoft`). Cuts to `to` at once under reduced motion, or while a
 * document crossfade holds the page and already fades this change. `onLanded` runs exactly once,
 * however the end state got up.
 */
export function turnLook(
  target: HTMLElement,
  to: Look,
  options: { readonly from?: Look; readonly onLanded?: () => void } = {},
): Turn {
  let landed = false;
  let tween: gsap.core.Tween | null = null;
  let cancelStart = () => {};
  const finish = () => {
    if (landed) return;
    landed = true;
    options.onLanded?.();
  };
  const land = () => {
    if (landed) return;
    cancelStart();
    tween?.kill();
    gsap.set(target, { ...to, overwrite: true });
    finish();
  };
  if (prefersReducedMotion() || holder !== null) {
    land();
    return { land };
  }
  const pace = {
    ...to,
    duration: tokens.ceremonialMedium,
    ease: tokens.easeSoft,
    onComplete: finish,
  };
  cancelStart = afterPaint(() => {
    tween = options.from ? gsap.fromTo(target, options.from, pace) : gsap.to(target, pace);
  });
  return { land };
}
