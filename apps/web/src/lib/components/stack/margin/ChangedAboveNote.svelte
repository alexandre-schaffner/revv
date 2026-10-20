<script lang="ts">
/*
 * "Changed again above": upper layers of the stack change the file this
 * issue or chapter is about. A fix asked for here lands under their changes,
 * so the reader should look at them first.
 */
import PencilLine from "phosphor-svelte/lib/PencilLine";
import LayerChip from "./LayerChip.svelte";
import MarginNote from "./MarginNote.svelte";
import { baseName, type ChangedAbove, type StackPlace } from "./stack-margin";

interface Props {
  note: ChangedAbove;
  place: StackPlace;
  /** Beside an issue: the note says what that means for a fix. */
  forIssue?: boolean;
}

let { note, place, forIssue = false }: Props = $props();

/** Room for two names; the rest are counted. */
const SHOWN_FILES = 2;
const shown = $derived(note.files.slice(0, SHOWN_FILES));
const more = $derived(note.files.length - shown.length);
</script>

<MarginNote icon={PencilLine} label="Changed again above">
	<p>
		{#each note.layers as layer, i (layer.number)}{#if i > 0}{i === note.layers.length - 1 ? ' and ' : ', '}{/if}<LayerChip {layer} {place} />{/each}
		{note.layers.length === 1 ? 'also changes' : 'also change'}
		{#each shown as file, i (file)}{#if i > 0}{i === shown.length - 1 && more === 0 ? ' and ' : ', '}{/if}<code title={file}>{baseName(file)}</code>{/each}{#if more > 0} and {more} more {more === 1 ? 'file' : 'files'}{/if}.
		{#if forIssue}Look there before asking for a fix here.{/if}
	</p>
</MarginNote>
