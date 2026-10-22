<script lang="ts">
import StackSimple from "phosphor-svelte/lib/StackSimple";
import BriefAction from "./BriefAction.svelte";
import Joined from "./Joined.svelte";
import LayerChip from "./LayerChip.svelte";
import MarginNote from "./MarginNote.svelte";
import RichLine from "./RichLine.svelte";
import { placePhrase, plainTitle, richText, type StackPlace } from "./stack-margin";

interface Props {
  place: StackPlace;
}

let { place }: Props = $props();

const roleParts = $derived(place.role ? richText(place.role, place.stack.layers) : []);
const buildsOn = $derived.by(() => {
  const cited = new Set(roleParts.flatMap((p) => (p.kind === "layer" ? [p.layer.number] : [])));
  return place.buildsOn.filter((l) => !cited.has(l.layer.number));
});
</script>

<MarginNote icon={StackSimple} label="In the stack" aside="{place.here.position} of {place.total}">
	<p>
		{placePhrase(place.here.position, place.total)}
		{#if place.headline}in <strong>{place.headline}</strong>.{:else}onto <code>{place.stack.baseRefName}</code>.{/if}
		{#if roleParts.length > 0}<RichLine parts={roleParts} {place} />{/if}
	</p>
	{#if buildsOn.length > 0 || place.usedBy.length > 0}
		<p>
			{#if buildsOn.length > 0}
				Stands on
				<Joined items={buildsOn} key={(link) => link.layer.number}>{#snippet item(link)}<LayerChip layer={link.layer} {place} />{#if link.uses} (<RichLine parts={richText(link.uses, [])} {place} />){/if}{/snippet}</Joined>.
			{/if}
			{#if place.usedBy.length > 0}
				Used above by
				<Joined items={place.usedBy} key={(link) => link.layer.number}>{#snippet item(link)}<LayerChip layer={link.layer} {place} />{/snippet}</Joined>.
			{/if}
		</p>
	{/if}
	{#if place.briefState !== 'current'}
		<p class="brief"><BriefAction {place} /></p>
	{/if}
	{#snippet foot()}
		{#if place.next}
			<span class="next">Next</span>
			<LayerChip layer={place.next} {place} />
			<span class="next-title">{plainTitle(place.next.title)}</span>
		{:else}
			<span>The top of the stack.</span>
		{/if}
	{/snippet}
</MarginNote>

<style>
	.brief {
		margin-top: 8px;
	}

	.next {
		flex-shrink: 0;
	}

	.next-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-secondary);
	}
</style>
