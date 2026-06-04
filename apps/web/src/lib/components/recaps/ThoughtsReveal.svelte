<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import type { Snippet } from "svelte";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible";

interface Props {
  open: boolean;
  blocks: ReadonlyArray<{ id: string; html: string }>;
  triggerClass: string;
  ariaLabel: string;
  prefix?: Snippet;
}

let { open = $bindable(), blocks, triggerClass, ariaLabel, prefix }: Props = $props();
</script>

<Collapsible bind:open>
  <CollapsibleTrigger class={triggerClass} aria-label={ariaLabel}>
    {#if prefix}{@render prefix()}{/if}
    <div class="meta">
      <span>Thoughts</span>
      <span class="chevron-wrap" data-state={open ? "open" : "closed"}>
        <CaretDown class="chevron" aria-hidden="true" />
      </span>
    </div>
  </CollapsibleTrigger>
  <CollapsibleContent class="thought-content">
    <div class="thought-stream">
      {#each blocks as block (block.id)}
        <div class="thought-markdown-block prose prose-sm">
          {@html block.html}
        </div>
      {/each}
    </div>
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

/* Markdown styling comes from the app-wide themed @tailwindcss/typography
   prose layer (see app.css). Thoughts read quieter than ordinary body prose,
   so the only override is to drop the body tone to muted. */
.thought-markdown-block {
  --tw-prose-body: var(--color-text-muted);
}

.thought-markdown-block + .thought-markdown-block {
  margin-top: 0.625rem;
}
</style>
