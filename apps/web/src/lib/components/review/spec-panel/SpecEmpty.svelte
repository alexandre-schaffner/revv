<script lang="ts">
/** The italic one-liner a spec panel shows when it has no rows to list. */
import type { Snippet } from "svelte";

interface Props {
  children: Snippet;
}

let { children }: Props = $props();
</script>

<div class="empty-state">{@render children()}</div>

<style>
    .empty-state {
        padding: 14px 16px;
        font-family: var(--font-mono);
        font-size: var(--text-ui);
        color: var(--color-text-muted);
        font-style: italic;
    }
</style>
