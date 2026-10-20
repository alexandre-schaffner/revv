<script lang="ts">
/*
 * "In the stack", when the pane is too narrow for a rail: one line under the
 * page subtitle that says where this layer sits and where the stack goes
 * next. The thumb index in the gutter still holds the whole stack.
 */
import StackSimple from "phosphor-svelte/lib/StackSimple";
import BriefAction from "./BriefAction.svelte";
import LayerChip from "./LayerChip.svelte";
import { placePhrase, plainTitle, type StackPlace } from "./stack-margin";

interface Props {
  place: StackPlace;
}

let { place }: Props = $props();
</script>

<aside class="line" data-margin-note aria-label="In the stack">
	<StackSimple size={13} weight="bold" aria-hidden="true" />
	<span class="where">
		{placePhrase(place.here.position, place.total)}
		{#if place.headline}in <strong>{place.headline}</strong>{:else}onto <code>{place.stack.baseRefName}</code>{/if}
	</span>
	{#if place.next}
		<span class="next">
			<span class="sep" aria-hidden="true">·</span>
			<span class="next-label">Next</span>
			<LayerChip layer={place.next} {place} />
			<span class="next-title">{plainTitle(place.next.title)}</span>
		</span>
	{/if}
	{#if place.briefState !== 'current'}
		<span class="brief"><span class="sep" aria-hidden="true">·</span><BriefAction {place} compact /></span>
	{/if}
</aside>

<style>
	.line {
		position: relative;
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
		margin-top: 4px;
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	.line > :global(svg) {
		flex-shrink: 0;
		align-self: center;
		color: var(--color-text-subtle);
	}

	.where {
		flex-shrink: 0;
	}

	.where strong {
		font-weight: 500;
		color: var(--color-text-primary);
	}

	code {
		font-family: var(--font-mono);
		font-size: 0.9em;
		color: var(--color-text-primary);
	}

	.next {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
		color: var(--color-text-subtle);
	}

	.next-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--color-text-secondary);
	}

	.sep {
		color: var(--color-text-subtle);
	}

	.brief {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		flex-shrink: 0;
	}
</style>
