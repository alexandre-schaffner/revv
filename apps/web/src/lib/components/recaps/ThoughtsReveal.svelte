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
    <div class="thought-stream thought-markdown">
      {#each blocks as block (block.id)}
        <div class="thought-markdown-block">
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
  color: var(--color-text-muted);
  font-size: 0.875rem;
  line-height: 1.6;
}

.thought-markdown-block + .thought-markdown-block {
  margin-top: 0.625rem;
}

.thought-markdown :global(p),
.thought-markdown :global(ul),
.thought-markdown :global(ol),
.thought-markdown :global(pre),
.thought-markdown :global(blockquote) {
  margin: 0 0 0.625rem;
}

.thought-markdown :global(blockquote) {
  padding: 8px 12px;
  margin: 0 0 12px;
  border: 1px solid color-mix(in srgb, var(--color-accent) 30%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 5%, transparent);
  border-radius: 6px;
  color: var(--color-text-secondary);
}

.thought-markdown :global(code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 0.08em 0.3em;
  border-radius: 0.25rem;
  background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
  color: var(--color-text-secondary);
}
</style>
