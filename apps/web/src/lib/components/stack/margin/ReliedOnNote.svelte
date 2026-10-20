<script lang="ts">
/*
 * "Relied on above": the upper layers the stack brief says stand on this
 * one, each with what it takes from it. What a change here would reach.
 */
import ArrowLineUp from "phosphor-svelte/lib/ArrowLineUp";
import LayerChip from "./LayerChip.svelte";
import MarginNote from "./MarginNote.svelte";
import RichLine from "./RichLine.svelte";
import { type LayerLink, richText, type StackPlace } from "./stack-margin";

interface Props {
  links: readonly LayerLink[];
  place: StackPlace;
}

let { links, place }: Props = $props();
</script>

<MarginNote icon={ArrowLineUp} label="Relied on above">
	{#each links as link (link.layer.number)}
		<p>
			<LayerChip layer={link.layer} {place} />
			{#if link.uses}uses <RichLine parts={richText(link.uses, [])} {place} />.{:else}builds on this layer.{/if}
		</p>
	{/each}
</MarginNote>
