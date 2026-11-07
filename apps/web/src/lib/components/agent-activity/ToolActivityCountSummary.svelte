<script lang="ts">
import { cn } from "$lib/utils.js";
import AnimatedNumber from "./AnimatedNumber.svelte";
import { activityGroupParts, type GroupableActivity } from "./activity-groups";

interface Props {
  items: readonly GroupableActivity[];
  class?: string;
}

let { items, class: className }: Props = $props();

const parts = $derived(activityGroupParts(items));
</script>

<span data-component="tool-count-summary" class={cn("tool-count-summary", className)}>
  {#each parts as part, index (part.key)}
    <span class="tool-count-item">
      <AnimatedNumber value={part.count} class="tool-count-number" />
      <span class="tool-count-word">
        <span class="tool-count-stem">{part.word}{index < parts.length - 1 ? ',' : ''}</span>
      </span>
    </span>
  {/each}
</span>

<style>
  .tool-count-summary {
    display: inline-flex;
    flex-shrink: 0;
    min-width: 0;
    align-items: baseline;
    gap: 0.375rem;
    overflow: hidden;
    white-space: nowrap;
    color: var(--color-text-muted);
    font: inherit;
    line-height: inherit;
  }

  .tool-count-item {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    font: inherit;
    line-height: inherit;
  }

  .tool-count-item :global(.tool-count-number) {
    min-width: 0.65em;
    text-align: right;
    color: var(--color-text-muted);
    font: inherit;
    line-height: inherit;
  }

  .tool-count-word {
    display: inline-grid;
    overflow: hidden;
    font: inherit;
    line-height: inherit;
  }

  .tool-count-stem {
    font: inherit;
    line-height: inherit;
  }
</style>
