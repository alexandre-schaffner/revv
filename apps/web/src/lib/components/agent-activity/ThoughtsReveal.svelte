<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import type { Snippet } from "svelte";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible";
import { splitAgentMarkdown } from "$lib/markdown/render";

interface Props {
  open: boolean;
  /** Streamed agent thoughts, shown when there are no `children`. */
  thoughts?: string;
  children?: Snippet;
  triggerClass: string;
  ariaLabel: string;
  prefix?: Snippet;
  metaLabel?: string;
}

let {
  open = $bindable(),
  thoughts = "",
  children,
  triggerClass,
  ariaLabel,
  prefix,
  metaLabel = "Thoughts",
}: Props = $props();

const thoughtBlocks = $derived(children ? [] : splitAgentMarkdown(thoughts));
</script>

<Collapsible bind:open>
  <CollapsibleTrigger class={triggerClass} aria-label={ariaLabel}>
    {#if prefix}{@render prefix()}{/if}
    <div class="meta">
      {#if metaLabel}<span>{metaLabel}</span>{/if}
      <span class="chevron-wrap" data-state={open ? "open" : "closed"}>
        <CaretDown class="chevron" aria-hidden="true" />
      </span>
    </div>
  </CollapsibleTrigger>
  <CollapsibleContent class="thought-content">
    {#if children}
      {@render children()}
    {:else}
      <div class="thought-stream">
        {#each thoughtBlocks as source, i (i)}
          <Markdown
            class="thought-markdown-block"
            {source}
            trust="agent"
            fade={i === thoughtBlocks.length - 1}
          />
        {/each}
      </div>
    {/if}
  </CollapsibleContent>
</Collapsible>

<style>
.meta {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.chevron-wrap {
  display: inline-grid;
  place-items: center;
  transition: transform var(--duration-snap) var(--ease-out-expo);
}

.chevron-wrap[data-state="open"] {
  transform: rotate(180deg);
}

.chevron-wrap :global(.chevron) {
  width: 0.75rem;
  height: 0.75rem;
}

.thought-stream {
  margin: 0.375rem 0 0;
}

/* Thoughts read quieter than ordinary body prose. */
.thought-stream :global(.thought-markdown-block) {
  --tw-prose-body: var(--color-text-muted);
}

.thought-stream :global(.thought-markdown-block + .thought-markdown-block) {
  margin-top: 0.625rem;
}
</style>
