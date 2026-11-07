<script lang="ts">
// Chips that jump to the walkthrough blocks something cites, labelled the way
// the walkthrough labels them ("Ch 2 · Step 3"). Blocks no longer on the page
// have nowhere to jump and get no chip.
import ArrowUpRight from "phosphor-svelte/lib/ArrowUpRight";
import { jumpToWalkthroughBlock } from "$lib/stores/review-nav.svelte";
import { getStepLabel } from "$lib/walkthrough/store.svelte";

interface Props {
  prId: string;
  blockIds: readonly string[];
  /** `row` tints the chips with the row's `--c-gutter-color`. */
  tone: "neutral" | "row";
}

let { prId, blockIds, tone }: Props = $props();

const links = $derived(
  blockIds.flatMap((blockId) => {
    const label = getStepLabel(prId, blockId);
    return label ? [{ blockId, label }] : [];
  }),
);
</script>

{#if links.length > 0}
<ul class="step-links">
    {#each links as { blockId, label } (blockId)}
        <li>
            <button
                type="button"
                class="step-link step-link--{tone}"
                onclick={() => jumpToWalkthroughBlock(blockId)}
            >
                <ArrowUpRight size={tone === "row" ? 10 : 11} aria-hidden="true" />
                {label}
            </button>
        </li>
    {/each}
</ul>
{/if}

<style>
    .step-links {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .step-link {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 8px;
        border-radius: 9999px;
        font-family: var(--font-mono);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.02em;
        cursor: pointer;
        transition:
            border-color var(--duration-snap) var(--ease-soft),
            color var(--duration-snap) var(--ease-soft),
            background var(--duration-snap) var(--ease-soft);
    }

    .step-link:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
    }

    .step-link--neutral {
        border: 1px solid var(--color-border);
        background: transparent;
        color: var(--color-text-muted);
    }

    .step-link--neutral:hover {
        border-color: var(--color-accent);
        color: var(--color-accent);
        background: color-mix(in srgb, var(--color-accent) 8%, transparent);
    }

    .step-link--row {
        border: 1px solid color-mix(in srgb, var(--c-gutter-color) 45%, transparent);
        background: color-mix(in srgb, var(--c-gutter-color) 8%, transparent);
        color: var(--c-gutter-color);
    }

    .step-link--row:hover {
        border-color: var(--c-gutter-color);
        background: color-mix(in srgb, var(--c-gutter-color) 15%, transparent);
    }
</style>
