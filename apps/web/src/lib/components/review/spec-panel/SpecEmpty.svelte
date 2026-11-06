<script lang="ts">
/** The italic one-liner a spec panel shows when it has no rows to list. */
import type { Snippet } from "svelte";

interface Props {
  /** The whole panel is this line, rather than a gap under the summary bar. */
  quiet?: boolean;
  children: Snippet;
}

let { quiet = false, children }: Props = $props();
</script>

<div class="empty-state" class:empty-state--quiet={quiet}>{@render children()}</div>

<style>
    .empty-state {
        padding: 14px 16px;
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-muted);
        font-style: italic;
    }

    .empty-state--quiet {
        padding: 10px 12px;
    }
</style>
