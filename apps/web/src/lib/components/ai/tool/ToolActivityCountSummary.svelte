<script lang="ts" module>
import type { GroupableActivity } from "$lib/utils/activity-groups";

export interface ToolActivityCountSummaryProps {
  items: readonly GroupableActivity[];
  class?: string;
}
</script>

<script lang="ts">
import AnimatedNumber from "./AnimatedNumber.svelte";
import { cn } from "$lib/utils.js";
import { robustActivityGroupCounts } from "$lib/utils/activity-groups";

let { items, class: className }: ToolActivityCountSummaryProps = $props();

const counts = $derived(robustActivityGroupCounts(items));
const visibleItems = $derived(
  [
    { key: "reads", count: counts.reads, one: "read", other: "reads" },
    { key: "searches", count: counts.searches, one: "search", other: "searches" },
    { key: "lists", count: counts.lists, one: "list", other: "lists" },
  ].filter((item) => item.count > 0),
);

function labelFor(item: { count: number; one: string; other: string }): string {
  return item.count === 1 ? item.one : item.other;
}
</script>

<span data-component="tool-count-summary" class={cn("tool-count-summary", className)}>
  {#each visibleItems as item, index (item.key)}
    <span class="tool-count-item">
      <AnimatedNumber value={item.count} class="tool-count-number" />
      <span class="tool-count-word">
        <span class="tool-count-stem">{labelFor(item)}{index < visibleItems.length - 1 ? ',' : ''}</span>
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
    transition:
      opacity var(--duration-quick) var(--ease-out-expo),
      transform var(--duration-quick) var(--ease-out-expo);
    will-change: transform, opacity;
  }

  @keyframes tool-count-item-in {
    from {
      opacity: 0;
      filter: blur(2px);
      transform: translateX(-0.25rem);
    }
    to {
      opacity: 1;
      filter: blur(0);
      transform: translateX(0);
    }
  }
</style>
