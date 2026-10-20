<script lang="ts" module>
import { isDocumentCrossfading, prefersReducedMotion, tokens } from "$lib/motion";

/**
 * How the plate turns to a new look, and how the hero's colours turn with it
 * (`RepoHero`), so the two keep one pace.
 */
export const PLATE_TURN = { duration: tokens.ceremonialMedium, ease: tokens.easeSoft };

/**
 * Whether a new look should turn (`PLATE_TURN`) rather than cut. During a
 * whole-page crossfade (`crossfadeDocument`) the page fades already; turning
 * inside it would play the change twice.
 */
export function plateTurns(): boolean {
  return !prefersReducedMotion() && !isDocumentCrossfading();
}
</script>

<script lang="ts">
/*
 * RepoEngraving — the repo's landscape plate, drawn to fill its parent.
 *
 * Purely decorative (`aria-hidden`). The drawing itself lives in
 * `$lib/utils/engraving`; this owns the canvases, their device-pixel size,
 * and when to redraw. A plate costs 15–30ms, so:
 *
 * - Nothing is painted while the plate is far off screen. The `/` feed holds
 *   one per synced repo; painting them all on landing, or all again inside a
 *   theme switch's crossfade, stalls the page for each one. A change that
 *   lands while the plate is away waits until it comes near and then just
 *   paints, since nobody saw the old one.
 * - A resize stretches the last frame until the size settles, then redraws
 *   once: too much to repeat on every frame of a sidebar drag, and the
 *   hatching is horizontal enough that a brief stretch doesn't show.
 * - A new look (the owner's ink resolving, a theme switch where the page
 *   itself doesn't crossfade) paints straight away onto a second canvas that
 *   fades in over the first, so the sky turns rather than cuts. The hero
 *   fades its own colours at the same pace (`RepoHero`). During a
 *   whole-page crossfade it just swaps.
 */

import type { Attachment } from "svelte/attachments";
import { afterPaint, gsap } from "$lib/motion";
import { drawEngraving, type EngravingInk } from "$lib/utils/engraving";

interface Props extends EngravingInk {
  seed: string;
  /** Day plate for the light theme, night plate for the dark. */
  time: "day" | "night";
  /** Width, from the left, the hero's text covers. See `EngravingOptions.textWidth`. */
  textWidth: number;
}

let { seed, ink, paper, textWidth, time }: Props = $props();

let width = $state(0);
let height = $state(0);
let base = $state<HTMLCanvasElement | null>(null);
let incoming = $state<HTMLCanvasElement | null>(null);
/** Within a screen and a half of the viewport, close enough to be worth painting. */
let near = $state(false);

const RESIZE_SETTLE_MS = 120;

const watchNear: Attachment<HTMLElement> = (host) => {
  const observer = new IntersectionObserver(
    (entries) => {
      const last = entries[entries.length - 1];
      if (last) near = last.isIntersecting;
    },
    { rootMargin: "600px 0px" },
  );
  observer.observe(host);
  return () => observer.disconnect();
};

function paint(canvas: HTMLCanvasElement, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawEngraving(ctx, { seed, ink, paper, width: w, height: h, textWidth, time });
}

/** Copy `from` onto `to`, size and all, then hide `from`. */
function settle(from: HTMLCanvasElement, to: HTMLCanvasElement) {
  to.width = from.width;
  to.height = from.height;
  to.getContext("2d")?.drawImage(from, 0, 0);
  gsap.set(from, { opacity: 0 });
}

let paintedLook = "";
let paintedSize = "";
/** The plate has been far off screen since it was last painted. */
let away = false;
let fade: gsap.core.Tween | null = null;

$effect(() => {
  const w = width;
  const h = height;
  const look = `${seed}|${ink}|${paper}|${time}|${textWidth}`;
  const back = base;
  const front = incoming;
  // `textWidth` is measured off the hero's text after layout; painting before
  // it arrives would place the moon twice.
  if (!back || !front || w === 0 || h === 0 || textWidth === 0) return;
  if (!near) {
    away = true;
    return;
  }
  const unseen = away;
  away = false;
  const size = `${w}x${h}`;

  if (!paintedLook || (unseen && (look !== paintedLook || size !== paintedSize))) {
    fade?.progress(1);
    paint(back, w, h);
    paintedLook = look;
    paintedSize = size;
    return;
  }

  if (size !== paintedSize) {
    const timer = setTimeout(() => {
      fade?.progress(1);
      paint(back, w, h);
      paintedLook = look;
      paintedSize = size;
    }, RESIZE_SETTLE_MS);
    return () => clearTimeout(timer);
  }

  if (look === paintedLook) return;
  paintedLook = look;
  // A fade still running lands first, so the new one starts from what's shown.
  fade?.progress(1);
  if (!plateTurns()) {
    paint(back, w, h);
    return;
  }
  paint(front, w, h);
  let started = false;
  const cancel = afterPaint(() => {
    started = true;
    fade = gsap.fromTo(
      front,
      { opacity: 0 },
      {
        opacity: 1,
        ...PLATE_TURN,
        onComplete: () => {
          fade = null;
          settle(front, back);
        },
      },
    );
  });
  return () => {
    cancel();
    // Interrupted before it began (scrolled away, say): land the new look
    // now, or the old one stays up under a plate already marked painted.
    if (!started) settle(front, back);
  };
});
</script>

<div
	class="engraving"
	aria-hidden="true"
	bind:clientWidth={width}
	bind:clientHeight={height}
	{@attach watchNear}
>
	<canvas bind:this={base}></canvas>
	<canvas class="incoming" bind:this={incoming}></canvas>
</div>

<style>
	.engraving {
		position: absolute;
		inset: 0;
		background: var(--plate-sky);
	}

	canvas {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
	}

	.incoming {
		opacity: 0;
	}
</style>
