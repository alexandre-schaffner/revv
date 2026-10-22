<script lang="ts">
import type { Attachment } from "svelte/attachments";
import { gsap, turnLook } from "$lib/motion";
import { drawEngraving, type EngravingInk, type EngravingOptions } from "$lib/utils/engraving";

interface Props extends EngravingInk {
  seed: string;
  time: "day" | "night";
  textWidth: number | null;
}

let { seed, ink, paper, textWidth, time }: Props = $props();

let width = $state(0);
let height = $state(0);
let base = $state<HTMLCanvasElement | null>(null);
let incoming = $state<HTMLCanvasElement | null>(null);
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

function paint(canvas: HTMLCanvasElement, opts: EngravingOptions) {
  drawEngraving(canvas, opts, window.devicePixelRatio || 1);
}

function settle(from: HTMLCanvasElement, to: HTMLCanvasElement) {
  to.width = from.width;
  to.height = from.height;
  to.getContext("2d")?.drawImage(from, 0, 0);
  gsap.set(from, { opacity: 0 });
}

let paintedLook = "";
let paintedSize = "";
let away = false;

$effect(() => {
  const w = width;
  const h = height;
  const look = `${seed}|${ink}|${paper}|${time}|${textWidth}`;
  const back = base;
  const front = incoming;
  if (!back || !front || w === 0 || h === 0 || textWidth === null) return;
  if (!near) {
    away = true;
    return;
  }
  const unseen = away;
  away = false;
  const size = `${w}x${h}`;
  const opts = { seed, ink, paper, width: w, height: h, textWidth, time };

  if (!paintedLook || (unseen && (look !== paintedLook || size !== paintedSize))) {
    paint(back, opts);
    paintedLook = look;
    paintedSize = size;
    return;
  }

  if (size !== paintedSize) {
    const timer = setTimeout(() => {
      paint(back, opts);
      paintedLook = look;
      paintedSize = size;
    }, RESIZE_SETTLE_MS);
    return () => clearTimeout(timer);
  }

  if (look === paintedLook) return;
  paintedLook = look;
  paint(front, opts);
  const turn = turnLook(
    front,
    { opacity: 1 },
    { from: { opacity: 0 }, onLanded: () => settle(front, back) },
  );
  return () => turn.land();
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
