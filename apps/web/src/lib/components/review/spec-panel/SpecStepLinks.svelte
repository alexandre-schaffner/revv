<script module lang="ts">
import type { WalkthroughBlock } from "@revv/shared";

interface StepLink {
  blockId: string;
  /** 1-based position in the walkthrough. */
  stepN: number;
}

/** Ids that no longer resolve to a block are dropped: they'd have nowhere to jump. */
export function resolveStepLinks(
  blockIds: readonly string[],
  blocks: readonly WalkthroughBlock[],
): StepLink[] {
  const out: StepLink[] = [];
  for (const blockId of blockIds) {
    const idx = blocks.findIndex((b) => b.id === blockId);
    if (idx >= 0) out.push({ blockId, stepN: idx + 1 });
  }
  return out;
}
</script>

<script lang="ts">
import ArrowUpRight from "phosphor-svelte/lib/ArrowUpRight";

interface Props {
  links: StepLink[];
  onJump: (blockId: string) => void;
  /** `row` tints the chips with the row's `--c-gutter-color`. */
  tone: "neutral" | "row";
}

let { links, onJump, tone }: Props = $props();
</script>

<ul class="step-links">
    {#each links as { blockId, stepN } (blockId)}
        <li>
            <button
                type="button"
                class="step-link step-link--{tone}"
                onclick={() => onJump(blockId)}
            >
                <ArrowUpRight size={tone === "row" ? 10 : 11} aria-hidden="true" />
                step {stepN}
            </button>
        </li>
    {/each}
</ul>

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
        text-transform: lowercase;
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
