<script lang="ts">
import type { Confidence, WalkthroughBlock, WalkthroughRating } from "@revv/shared";
import { RATING_AXIS_LABELS } from "@revv/shared";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import FileBadge from "$lib/components/ui/FileBadge.svelte";
import * as Tooltip from "$lib/components/ui/tooltip";
import { jumpToDiffLine } from "$lib/stores/review-nav.svelte";
import SpecExpandedBody from "./SpecExpandedBody.svelte";
import SpecReferences from "./SpecReferences.svelte";
import SpecSection from "./SpecSection.svelte";
import SpecStepLinks, { resolveStepLinks } from "./SpecStepLinks.svelte";

interface Props {
  rating: WalkthroughRating;
  blocks: WalkthroughBlock[];
  onJump: (blockId: string) => void;
}

let { rating, blocks, onJump }: Props = $props();

const stepLinks = $derived(resolveStepLinks(rating.blockIds, blocks));

const details = $derived(rating.details?.trim() ? rating.details : null);

// Opening the popover moves focus into this body; without the delay that
// focus would pop the first citation's tooltip straight away.
let tooltipsEnabled = $state(false);
$effect(() => {
  tooltipsEnabled = false;
  const t = setTimeout(() => {
    tooltipsEnabled = true;
  }, 600);
  return () => clearTimeout(t);
});

const confidenceLabels: Record<Confidence, string> = {
  low: "low confidence",
  medium: "medium confidence",
  high: "high confidence",
};
</script>

<SpecExpandedBody standalone>
    <h3 class="score-title">
        <span class="score-title-dot" aria-hidden="true"></span>
        {RATING_AXIS_LABELS[rating.axis]}
    </h3>

    <!-- Jest-style: the verdict we got against the pass we wanted, then the
         rationale as the explanation. -->
    <SpecSection label="status" lead>
        <div class="expected-received">
            <div class="er-row">
                <span class="er-label">Expected:</span>
                <span class="er-value er-value--pass">pass</span>
            </div>
            <div class="er-row">
                <span class="er-label">Received:</span>
                <span class="er-value er-value--{rating.verdict}">{rating.verdict}</span>
                <span class="er-confidence">{confidenceLabels[rating.confidence]}</span>
            </div>
        </div>

        <div class="rationale">
            <Markdown class="rationale-text" source={rating.rationale} trust="agent" density="dense" />
        </div>
    </SpecSection>

    {#if details}
        <SpecSection label="details">
            <div class="rating-details-host">
                <Markdown class="rating-details" source={details} trust="agent" density="dense" />
            </div>
        </SpecSection>
    {/if}

    {#if rating.citations.length > 0}
        <SpecSection label="references">
            <Tooltip.Provider delayDuration={300}>
                <SpecReferences>
                    {#each rating.citations as citation, i (i)}
                        <li>
                            {#if citation.note}
                                <Tooltip.Root delayDuration={300} disabled={!tooltipsEnabled}>
                                    <Tooltip.Trigger>
                                        {#snippet child({ props })}
                                            <span class="reference-trigger" {...props}>
                                                <FileBadge
                                                    filePath={citation.filePath}
                                                    startLine={citation.startLine}
                                                    endLine={citation.endLine}
                                                    onclick={() =>
                                                        jumpToDiffLine(citation.filePath, citation.startLine)}
                                                />
                                            </span>
                                        {/snippet}
                                    </Tooltip.Trigger>
                                    <Tooltip.Content side="right">{citation.note}</Tooltip.Content>
                                </Tooltip.Root>
                            {:else}
                                <FileBadge
                                    filePath={citation.filePath}
                                    startLine={citation.startLine}
                                    endLine={citation.endLine}
                                    onclick={() => jumpToDiffLine(citation.filePath, citation.startLine)}
                                />
                            {/if}
                        </li>
                    {/each}
                </SpecReferences>
            </Tooltip.Provider>
        </SpecSection>
    {/if}

    {#if stepLinks.length > 0}
        <SpecStepLinks links={stepLinks} {onJump} tone="neutral" />
    {/if}
</SpecExpandedBody>

<style>
    .rationale {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        position: relative;
    }

    /* Primary body tone via the prose token so headings/bold track it too. */
    .rationale :global(.rationale-text) {
        font-family: var(--font-sans);
        --tw-prose-body: var(--color-text-primary);
        margin: 0;
        max-width: 65ch;
    }

    .expected-received {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 1.5;
    }

    .er-row {
        display: flex;
        align-items: baseline;
        gap: 10px;
    }

    .er-label {
        color: var(--color-text-muted);
        min-width: 10ch;
        text-align: left;
    }

    .er-value {
        font-weight: 600;
    }

    .er-value--pass {
        color: var(--color-score-pass-label);
    }

    .er-value--concern {
        color: var(--color-score-concern-label);
    }

    .er-value--blocker {
        color: var(--color-score-blocker-label);
    }

    .er-confidence {
        color: var(--color-text-muted);
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.02em;
    }

    .score-title {
        margin: 0;
        font-family: var(--font-mono);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--c-rating-label);
        display: flex;
        align-items: center;
    }

    .score-title-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--c-rating-icon);
        margin-right: 7px;
        flex-shrink: 0;
        position: relative;
        top: -1px;
    }

    .rating-details-host :global(.rating-details) {
        font-family: var(--font-sans);
        --tw-prose-body: var(--color-text-primary);
        max-height: 480px;
        overflow-y: auto;
        max-width: 65ch;
    }

    .rating-details-host :global(.rating-details h3) {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--color-text-muted);
        margin: 12px 0 4px;
    }

    .reference-trigger {
        display: inline-flex;
    }
</style>
