<script lang="ts">
import type { RichPart, StackPlace } from "$lib/stacks/stack-margin";
import LayerChip from "./LayerChip.svelte";

interface Props {
  parts: readonly RichPart[];
  place: StackPlace;
}

let { parts, place }: Props = $props();
</script>

{#each parts as part, i (i)}{#if part.kind === 'code'}<code>{part.text}</code>{:else if part.kind === 'layer'}<LayerChip layer={part.layer} {place} />{:else}{part.text}{/if}{/each}
