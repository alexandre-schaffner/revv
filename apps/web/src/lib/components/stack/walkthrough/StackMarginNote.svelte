<script lang="ts">
/*
 * The stack's note beside a walkthrough section: "Relied on above" by the
 * Overview (index -1), "Changed again above" by a chapter.
 */
import ChangedAboveNote from "../margin/ChangedAboveNote.svelte";
import ReliedOnNote from "../margin/ReliedOnNote.svelte";
import type { WalkthroughStack } from "./walkthrough-stack.svelte";

interface Props {
  stack: WalkthroughStack;
  /** The section's semantic step index; -1 is the Overview. */
  index: number;
}

let { stack, index }: Props = $props();

const changed = $derived(stack.notes?.chapters.get(index));
</script>

{#if stack.notes && stack.place}
	{#if index === -1 && stack.notes.reliedOn.length > 0}
		<ReliedOnNote links={stack.notes.reliedOn} place={stack.place} />
	{:else if changed}
		<ChangedAboveNote note={changed} place={stack.place} />
	{/if}
{/if}
