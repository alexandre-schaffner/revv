<script lang="ts">
/** The open body of a spec row or rating: a column of `SpecSection`s, inset under the row's label. */
import type { Snippet } from "svelte";

interface Props {
  /** Shown on its own (a popover) rather than under a row trigger: pads the top like the bottom. */
  standalone?: boolean;
  children: Snippet;
}

let { standalone = false, children }: Props = $props();
</script>

<div class="expanded-body" class:expanded-body--standalone={standalone}>
    {@render children()}
</div>

<style>
    .expanded-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 10px 12px 16px calc(2ch + 14px);
        font-family: var(--font-mono);
        font-size: 12.5px;
        color: var(--color-text-secondary);
        background: var(--c-row-bg, var(--color-bg-secondary));
    }

    .expanded-body--standalone {
        padding-top: 16px;
    }
</style>
