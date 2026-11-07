<script lang="ts">
import ArrowLineUp from "phosphor-svelte/lib/ArrowLineUp";
import { type LayerLink, richText, type StackPlace } from "$lib/stacks/stack-margin";
import LayerChip from "./LayerChip.svelte";
import MarginNote from "./MarginNote.svelte";
import RichLine from "./RichLine.svelte";

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
