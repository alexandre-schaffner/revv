<script lang="ts">
/*
 * RepoEngraving — the repo's landscape plate, drawn to fill its parent.
 *
 * Purely decorative (`aria-hidden`). The drawing itself lives in
 * `$lib/utils/engraving`; this owns the canvases, their device-pixel size,
 * and when to redraw. Two kinds of change, handled differently:
 *
 * - A resize stretches the last frame until the size settles, then redraws
 *   once: a plate costs 15–30ms, too much to repeat on every frame of a
 *   sidebar drag, and the hatching is horizontal enough that a brief stretch
 *   doesn't show.
 * - A new look (the owner's ink resolving, a theme switch where the page
 *   itself doesn't crossfade) paints straight away onto a second canvas that
 *   fades in over the first, so the sky turns rather than cuts. The hero
 *   fades its own colours at the same pace (see `RepoHomeSection`). During a
 *   whole-page crossfade (`crossfadeDocument`) it just swaps.
 */

import { afterPaint, gsap, isDocumentCrossfading, prefersReducedMotion, tokens } from "$lib/motion";
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

const RESIZE_SETTLE_MS = 120;

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
  const size = `${w}x${h}`;

  if (!paintedLook) {
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
  // A theme switch fades the whole page already; fading the plate inside
  // it would play the change twice.
  if (prefersReducedMotion() || isDocumentCrossfading()) {
    paint(back, w, h);
    return;
  }
  paint(front, w, h);
  return afterPaint(() => {
    fade = gsap.fromTo(
      front,
      { opacity: 0 },
      {
        opacity: 1,
        duration: tokens.ceremonialMedium,
        ease: tokens.easeSoft,
        onComplete: () => {
          fade = null;
          settle(front, back);
        },
      },
    );
  });
});
</script>

<div class="engraving" aria-hidden="true" bind:clientWidth={width} bind:clientHeight={height}>
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
