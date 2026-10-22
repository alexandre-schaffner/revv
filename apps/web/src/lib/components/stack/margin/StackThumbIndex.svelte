<script lang="ts">
import type { StackLayer } from "@revv/shared";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import { gsapHover } from "$lib/motion";
import { getHoveredLayer } from "$lib/stores/stack-hover.svelte";
import { openLayer, remainingLayers } from "$lib/stores/stack-nav.svelte";
import StackLayerGlyph from "../StackLayerGlyph.svelte";
import { layerHint, plainTitle, type StackPlace } from "./stack-margin";

interface Props {
  place: StackPlace;
}

let { place }: Props = $props();

let open = $state(false);
let sheet: HTMLElement | null = $state(null);

const groups = $derived(
  [...place.chapters].reverse().map((c) => ({ name: c.name, layers: [...c.layers].reverse() })),
);
const pitch = $derived(Math.max(3, Math.min(7, 80 / place.total)));
const hovered = $derived(getHoveredLayer());
const toReview = $derived(open ? remainingLayers(place.stack).length : 0);
const label = $derived(
  `Layer ${place.here.position} of ${place.total}${place.headline ? ` in ${place.headline}` : ""}, show the stack`,
);

type Tone = "current" | "merged" | "reviewed" | "reviewing" | "open";

function toneOf(layer: StackLayer): Tone {
  if (layer.number === place.here.number) return "current";
  if (layer.status === "merged") return "merged";
  if (layer.review.kind === "complete") return "reviewed";
  if (layer.review.kind === "generating") return "reviewing";
  return "open";
}

function items(): HTMLElement[] {
  return sheet ? Array.from(sheet.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
}

function focusHere(event: Event): void {
  event.preventDefault();
  sheet?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
}

function rove(event: KeyboardEvent): void {
  const list = items();
  const at = list.indexOf(document.activeElement as HTMLElement);
  const to =
    event.key === "ArrowDown"
      ? Math.min(list.length - 1, at + 1)
      : event.key === "ArrowUp"
        ? Math.max(0, at - 1)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? list.length - 1
            : null;
  if (to === null) return;
  event.preventDefault();
  list[to]?.focus();
}

function choose(layer: StackLayer): void {
  open = false;
  if (layer.number !== place.here.number) openLayer(layer);
}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="index"
				aria-label={label}
				use:gsapHover={{ prop: '--h' }}
			>
				<span class="notches" style:--pitch="{pitch}px" aria-hidden="true">
					{#each groups as group (group.layers[0]?.number)}
						<span class="chapter">
							{#each group.layers as layer (layer.number)}
								<span class="notch notch--{toneOf(layer)}" class:notch--lit={hovered === layer.number}></span>
							{/each}
						</span>
					{/each}
				</span>
				<span class="place" aria-hidden="true"><b>{place.here.position}</b>/{place.total}</span>
			</button>
		{/snippet}
	</PopoverTrigger>
	<PopoverContent
		class="w-[440px] gap-0 p-1.5"
		side="right"
		align="start"
		sideOffset={10}
		onOpenAutoFocus={focusHere}
	>
		<div class="sheet" bind:this={sheet} role="menu" tabindex="-1" aria-label="Layers of the stack" onkeydown={rove}>
			<div class="sheet-head">
				{#if place.headline}<span class="sheet-title">{place.headline}</span>{/if}
				<span class="sheet-sub">{place.total} layers onto <code>{place.stack.baseRefName}</code>{#if toReview > 0}<span class="sheet-dot" aria-hidden="true">·</span>{toReview} to review{/if}</span>
			</div>
			{#each groups as group (group.layers[0]?.number)}
				<div class="group" role="group" aria-label={group.name ?? undefined}>
					{#if group.name}<div class="group-name" aria-hidden="true">{group.name}</div>{/if}
					{#each group.layers as layer (layer.number)}
						{@const here = layer.number === place.here.number}
						<button
							type="button"
							class="item"
							class:item--here={here}
							role="menuitem"
							aria-current={here ? 'true' : undefined}
							onclick={() => choose(layer)}
						>
							<StackLayerGlyph status={layer.status} size={12} />
							<span class="item-num">#{layer.number}</span>
							<span class="item-title">{plainTitle(layer.title)}</span>
							<span class="item-state">{layerHint(layer, place.here)}</span>
						</button>
					{/each}
				</div>
			{/each}
		</div>
	</PopoverContent>
</PopoverRoot>

<style>
	.index {
		--h: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 7px;
		margin: 0;
		padding: 0;
		border: none;
		background: transparent;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.index:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 4px;
		border-radius: 3px;
	}

	.notches,
	.chapter {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
	}

	.notches {
		gap: calc(var(--pitch) + 1px);
	}

	.chapter {
		gap: calc(var(--pitch) - 1.5px);
	}

	.notch {
		position: relative;
		display: block;
		width: 8px;
		height: 1.5px;
		border-radius: 1px;
		background: var(--tone);
		transform-origin: 100% 50%;
		scale: calc(1 + var(--h) * 0.3) 1;
	}

	.notch::after {
		content: "";
		position: absolute;
		inset: 0 0 0 -8px;
		border-radius: inherit;
		background: var(--color-accent);
		opacity: 0;
	}

	.notch--lit::after {
		opacity: 1;
	}

	.notch--open {
		--tone: color-mix(in srgb, var(--color-text-muted) 80%, transparent);
	}

	.notch--reviewing {
		--tone: color-mix(in srgb, var(--color-accent) 55%, transparent);
	}

	.notch--reviewed {
		--tone: var(--color-text-secondary);
	}

	.notch--merged {
		--tone: var(--color-merged);
	}

	.notch--current {
		--tone: var(--color-accent);
		width: 20px;
		height: 2px;
	}

	.place {
		font-family: var(--font-mono);
		font-size: 10.5px;
		line-height: 1;
		color: var(--color-text-subtle);
		font-variant-numeric: tabular-nums;
	}

	.place b {
		font-weight: 500;
		color: var(--color-accent);
	}

	.sheet {
		max-height: min(78vh, 760px);
		overflow-y: auto;
		outline: none;
	}

	.sheet-head {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 8px 8px;
	}

	.sheet-title {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.sheet-sub {
		font-size: 12px;
		color: var(--color-text-subtle);
	}

	.sheet-dot {
		margin: 0 6px;
	}

	.sheet-sub code {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-secondary);
	}

	.group + .group {
		margin-top: 4px;
	}

	.group-name {
		padding: 6px 8px 2px;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.item {
		display: grid;
		grid-template-columns: 12px auto minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 8px;
		width: 100%;
		height: 26px;
		margin: 0;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		font: inherit;
		font-size: 12.5px;
		text-align: left;
		color: inherit;
		cursor: pointer;
	}

	.item:hover,
	.item:focus-visible {
		background: color-mix(in srgb, var(--color-text-primary) 7%, transparent);
		outline: none;
	}

	.item--here,
	.item--here:hover,
	.item--here:focus-visible {
		background: var(--color-tree-active-bg);
	}

	.item--here:focus-visible {
		box-shadow: inset 0 0 0 1px var(--color-accent);
	}

	.item-num {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-subtle);
	}

	.item-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-primary);
	}

	.item--here .item-title {
		color: var(--color-tree-active-text);
	}

	.item-state {
		font-size: 11px;
		color: var(--color-text-subtle);
		white-space: nowrap;
	}

	.item--here .item-state {
		color: var(--color-accent);
	}
</style>
