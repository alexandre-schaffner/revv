<script lang="ts" module>
import type { GroupableActivity } from "./activity-groups";

export interface ToolActivityGroupProps {
  items: readonly GroupableActivity[];
  active?: boolean;
  defaultOpen?: boolean;
  forceOpenWhileActive?: boolean;
  class?: string;
}
</script>

<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import { Shimmer } from "$lib/components/ui/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible";
import { gsapFadeY, tokens } from "$lib/motion";
import { cn } from "$lib/utils.js";
import { activityGroupSummary } from "./activity-groups";
import ToolActivityCountSummary from "./ToolActivityCountSummary.svelte";
import ToolCallCard from "./ToolCallCard.svelte";

let {
  items,
  active = false,
  defaultOpen = false,
  forceOpenWhileActive = false,
  class: className,
}: ToolActivityGroupProps = $props();

let open = $state(false);
let initialized = $state(false);
const summary = $derived(activityGroupSummary(items));
const title = $derived(active ? "Exploring" : "Explored");

$effect(() => {
  if (!initialized) {
    open = defaultOpen;
    initialized = true;
  }
  if (active && forceOpenWhileActive) open = true;
});

</script>

<div
  class={cn("tool-activity-group", className)}
  data-component="tool-activity-group"
  data-state={open ? "open" : "closed"}
  in:gsapFadeY|global={{ y: 4, duration: tokens.quick }}
>
  <Collapsible bind:open>
    <CollapsibleTrigger class="tool-activity-trigger" aria-label={`${title}: ${summary}`}>
      <div class="tool-activity-trigger-main">
        <span class="tool-activity-title">
          <Shimmer active={active}>{title}</Shimmer>
        </span>
        <ToolActivityCountSummary items={items} class="tool-activity-summary" />
      </div>
      <CaretDown class="tool-activity-chevron" aria-hidden="true" />
    </CollapsibleTrigger>

    <CollapsibleContent class="tool-activity-content">
      <div class="tool-activity-list">
        {#each items as item (item.id)}
          <ToolCallCard
            activityKind={item.activityKind}
            toolName={item.toolName}
            summary={item.summary}
            payload={item.payload}
            output={item.output}
            isError={item.isError}
          />
        {/each}
      </div>
    </CollapsibleContent>
  </Collapsible>
</div>

<style>
  .tool-activity-group {
    display: block;
    width: 100%;
    overflow: hidden;
    border-radius: 0.375rem;
  }

  .tool-activity-group :global(.tool-activity-trigger) {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 0.375rem;
    padding: 0.125rem 0;
    text-align: left;
  }

  .tool-activity-trigger-main {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.875rem;
    line-height: 1.45;
  }

  .tool-activity-title {
    flex-shrink: 0;
    font: inherit;
    font-weight: 500;
    line-height: inherit;
    color: var(--color-text-primary);
  }

  .tool-activity-summary {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: inherit;
    line-height: inherit;
    color: var(--color-text-muted);
  }

  .tool-activity-group :global(.tool-activity-chevron) {
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform var(--duration-snap) var(--ease-out-expo);
  }

  .tool-activity-group[data-state="open"] :global(.tool-activity-chevron) {
    transform: rotate(180deg);
  }

  .tool-activity-group :global(.tool-activity-content) {
    overflow: hidden;
  }

  .tool-activity-group :global(.tool-activity-content[data-state="closed"]) {
    display: none;
  }

  .tool-activity-list {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.375rem 0 0.125rem 0.5rem;
  }
</style>
