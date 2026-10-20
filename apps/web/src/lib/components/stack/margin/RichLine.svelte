<script lang="ts">
/* A brief line as prose: `code` spans set in mono, `#N` layers as chips. */
import LayerChip from "./LayerChip.svelte";
import type { RichPart, StackPlace } from "./stack-margin";

interface Props {
  parts: readonly RichPart[];
  place: StackPlace;
}

let { parts, place }: Props = $props();
</script>

{#each parts as part, i (i)}{#if part.kind === 'code'}<code>{part.text}</code>{:else if part.kind === 'layer'}<LayerChip layer={part.layer} {place} />{:else}{part.text}{/if}{/each}
