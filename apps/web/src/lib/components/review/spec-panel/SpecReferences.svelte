<script lang="ts">
/** A stack-trace style list: each child `<li>` reads "at <file badge>". */
import type { Snippet } from "svelte";

interface Props {
  children: Snippet;
}

let { children }: Props = $props();
</script>

<ul class="references">{@render children()}</ul>

<style>
    .references {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: flex-start;
    }

    .references > :global(li) {
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-secondary);
    }

    .references > :global(li)::before {
        content: "at ";
        color: var(--color-text-muted);
        font-family: var(--font-mono);
        font-size: 12px;
        letter-spacing: 0.02em;
    }
</style>
