<script lang="ts">
/*
 * One layer of the stack, previewed where the reader's pointer already is:
 * what it is, what it contributes, where its review stands. Hangs from the
 * margin note its chip sits in, above the note when there's room so it
 * never covers the sentence that cited it.
 */
import type { StackLayer } from "@revv/shared";
import ArrowRight from "phosphor-svelte/lib/ArrowRight";
import Warning from "phosphor-svelte/lib/Warning";
import { gsapFadeY, tokens } from "$lib/motion";
import { layerRole, REVIEW_VERDICT_LABEL } from "$lib/stacks/stack-layer-facts";
import StackLayerGlyph from "../StackLayerGlyph.svelte";
import { layerHint, plainTitle, richText, type StackPlace } from "./stack-margin";

interface Props {
  layer: StackLayer;
  place: StackPlace;
  /** Offsets inside the positioned note. */
  x: number;
  y: number;
  /** Which edge `y` names: the card stands above it, or hangs below it. */
  from: "top" | "bottom";
}

let { layer, place, x, y, from }: Props = $props();

const STATUS_LABEL: Record<StackLayer["status"], string> = {
  merged: "Merged",
  ready: "Ready",
  not_ready: "Not ready",
  draft: "Draft",
  closed: "Closed",
};

const chapter = $derived(
  place.chapters.find((c) => c.layers.some((l) => l.number === layer.number))?.name ?? null,
);
const role = $derived(layerRole(layer, place.brief));
const hint = $derived(layerHint(layer, place.here) || "Not reviewed");
const verdict = $derived(
  layer.viewerReview && layer.viewerReview !== "dismissed"
    ? REVIEW_VERDICT_LABEL[layer.viewerReview]
    : null,
);
const openable = $derived(layer.number !== place.here.number);
</script>

<div
	class="peek"
	style:left="{x}px"
	style:top={from === 'top' ? `${y}px` : undefined}
	style:bottom={from === 'bottom' ? `${y}px` : undefined}
	role="tooltip"
	in:gsapFadeY={{ y: from === 'top' ? -4 : 4, duration: tokens.quick }}
	out:gsapFadeY={{ y: from === 'top' ? -4 : 4, duration: tokens.snap }}
>
	<div class="head">
		<StackLayerGlyph status={layer.status} size={13} />
		<span class="num">#{layer.number}</span>
		<span class="where">{chapter ? `${chapter} · ` : ''}{layer.position} of {place.total}</span>
		<span class="status">{STATUS_LABEL[layer.status]}</span>
	</div>
	<div class="title">{plainTitle(layer.title)}</div>
	{#if role}
		<p class="role">
			{#each richText(role, []) as part, i (i)}{#if part.kind === 'code'}<code>{part.text}</code>{:else if part.kind === 'text'}{part.text}{/if}{/each}
		</p>
	{/if}
	<div class="foot">
		<span class="fact" class:fact--warning={layer.restack.kind === 'needs-rebase'}>
			{#if layer.restack.kind === 'needs-rebase'}<Warning size={12} weight="fill" />{/if}
			{hint}{verdict ? ` · ${verdict}` : ''}
		</span>
		{#if openable}
			<span class="open">Open <ArrowRight size={11} /></span>
		{/if}
	</div>
</div>

<style>
	.peek {
		position: absolute;
		z-index: 30;
		width: 340px;
		box-sizing: border-box;
		padding: 12px 14px 10px;
		border: 1px solid var(--color-border);
		border-radius: 10px;
		background: var(--color-bg-elevated);
		box-shadow: var(--color-shadow-sm);
		pointer-events: none;
		text-align: left;
		white-space: normal;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11.5px;
		line-height: 1;
		color: var(--color-text-subtle);
		font-variant-numeric: tabular-nums;
	}

	.num {
		font-family: var(--font-mono);
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	.status {
		margin-left: auto;
	}

	.title {
		margin-top: 8px;
		font-size: 13px;
		font-weight: 600;
		line-height: 1.35;
		color: var(--color-text-primary);
		text-wrap: pretty;
	}

	.role {
		display: -webkit-box;
		margin: 4px 0 0;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--color-text-secondary);
		text-wrap: pretty;
	}

	code {
		font-family: var(--font-mono);
		font-size: 0.92em;
		color: var(--color-text-primary);
	}

	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 10px;
		padding-top: 8px;
		border-top: 1px solid var(--color-border-subtle);
		font-size: 11.5px;
		color: var(--color-text-subtle);
	}

	:global(.dark) .foot {
		border-top-color: var(--color-border);
	}

	.fact {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.fact--warning :global(svg) {
		color: var(--color-warning);
	}

	.open {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--color-text-muted);
	}
</style>
