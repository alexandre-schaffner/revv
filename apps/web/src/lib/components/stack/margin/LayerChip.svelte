<script lang="ts">
/*
 * `#3943`, cited in a margin note: the layer's state glyph and number, the
 * same chip the walkthrough's prose citations mint. Hover previews the layer
 * and lights its notch in the thumb index by the title; a press opens it.
 */
import type { StackLayer } from "@revv/shared";
import { gsapHover } from "$lib/motion";
import { setHoveredLayer } from "$lib/stores/stack-hover.svelte";
import { openLayer } from "$lib/stores/stack-nav.svelte";
import StackLayerGlyph from "../StackLayerGlyph.svelte";
import LayerPeek from "./LayerPeek.svelte";
import { plainTitle, type StackPlace } from "./stack-margin";

interface Props {
  layer: StackLayer;
  place: StackPlace;
}

let { layer, place }: Props = $props();

/** Roughly the preview's height; enough to decide whether it fits above. */
const PEEK_ROOM = 170;
const PEEK_WIDTH = 340;
/** Clear of the note's own hairline, so the rule still reads. */
const PEEK_GAP = 10;

/** Where the preview last hung. Kept after it closes: the card reads it on
 * its way out, so clearing it would throw mid-outro and strand the card. */
let peek = $state<{ x: number; y: number; from: "top" | "bottom" } | null>(null);
let peeking = $state(false);

const here = $derived(layer.number === place.here.number);
const label = $derived(
  `#${layer.number}, layer ${layer.position} of ${place.total}: ${plainTitle(layer.title)}`,
);

function show(event: Event): void {
  setHoveredLayer(layer.number);
  const chip = event.currentTarget as HTMLElement;
  const host = chip.closest<HTMLElement>("[data-margin-note]");
  if (!host) return;
  const c = chip.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  const x = Math.max(0, Math.min(h.width - PEEK_WIDTH, c.left - h.left - 12));
  // Above the note, unless that would reach past the scroll pane's top edge
  // (which clips it) or over another margin note in the same rail: then it
  // hangs below, wherever there's more room.
  const pane = chip.closest(".review-content")?.getBoundingClientRect() ?? null;
  let ceiling = pane?.top ?? 0;
  let floor = pane?.bottom ?? window.innerHeight;
  for (const other of document.querySelectorAll<HTMLElement>("[data-margin-note]")) {
    if (other === host) continue;
    const o = other.getBoundingClientRect();
    if (o.width === 0 || o.right <= h.left || o.left >= h.right) continue;
    if (o.bottom <= h.top) ceiling = Math.max(ceiling, o.bottom);
    else if (o.top >= h.bottom) floor = Math.min(floor, o.top);
  }
  const above = h.top - ceiling;
  const below = floor - h.bottom;
  const from = above >= PEEK_ROOM + PEEK_GAP || above >= below ? "bottom" : "top";
  peek = { x, y: h.height + PEEK_GAP, from };
  peeking = true;
}

function hide(): void {
  setHoveredLayer(null);
  peeking = false;
}
</script>

<button
	type="button"
	class="chip"
	data-status={layer.status}
	aria-label={here ? `${label}, the layer on screen` : `Open ${label}`}
	disabled={here}
	use:gsapHover={{ prop: '--h' }}
	onpointerenter={show}
	onpointerleave={hide}
	onfocus={show}
	onblur={hide}
	onclick={() => {
		hide();
		openLayer(layer);
	}}
>
	<StackLayerGlyph status={layer.status} size={11} />
	<span class="num">#{layer.number}</span>
</button>{#if peeking && peek}<LayerPeek {layer} {place} x={peek.x} y={peek.y} from={peek.from} />{/if}

<style>
	.chip {
		--h: 0;
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin: 0 0.0625rem;
		padding: 0 0.375rem 0 0.3125rem;
		border: 1px solid var(--color-border);
		border-radius: 0.3125rem;
		background: color-mix(in srgb, var(--color-text-muted) 7%, var(--color-bg-primary));
		font: inherit;
		line-height: 1.45;
		vertical-align: baseline;
		white-space: nowrap;
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.chip:disabled {
		cursor: default;
	}

	/* Lit by crossfading an accent ring over the chip, not by repainting it. */
	.chip::after {
		content: "";
		position: absolute;
		inset: -1px;
		border: 1px solid var(--color-accent);
		border-radius: inherit;
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
		opacity: var(--h);
		pointer-events: none;
	}

	.chip:disabled::after {
		opacity: 0;
	}

	.chip:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}

	.num {
		font-family: var(--font-mono);
		font-size: 0.875em;
		font-weight: 500;
	}
</style>
