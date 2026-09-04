<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
  title: string;
  hint?: string | undefined;
  actions?: Snippet;
  children: Snippet;
  /** Remove body padding (for tables that manage their own). */
  flush?: boolean;
}

const { title, hint, actions, children, flush = false }: Props = $props();
</script>

<section class="rounded-lg border border-border bg-surface/60">
  <header class="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5">
    <div class="flex items-baseline gap-2 min-w-0">
      <h2 class="text-[0.8125rem] font-semibold text-ink truncate">{title}</h2>
      {#if hint}
        <span class="text-xs text-ink-muted truncate">{hint}</span>
      {/if}
    </div>
    {#if actions}
      <div class="flex shrink-0 items-center gap-1.5">{@render actions()}</div>
    {/if}
  </header>
  <div class={flush ? "" : "p-4"}>
    {@render children()}
  </div>
</section>
