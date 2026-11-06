<script lang="ts">
import type { RatingAxis, WalkthroughBlock, WalkthroughRating } from "@revv/shared";
import { RATING_AXIS_LABELS } from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import Spinner from "phosphor-svelte/lib/Spinner";
import Warning from "phosphor-svelte/lib/Warning";
import XCircle from "phosphor-svelte/lib/XCircle";
import { fromAction } from "svelte/attachments";
import * as Popover from "$lib/components/ui/popover";
import { type EnterParams, enterOnce } from "$lib/motion";
import RatingExpandedBody from "./RatingExpandedBody.svelte";
import { synthesize } from "./rating-synthesis";

export type CellState = "queued" | "running" | "resolved";

interface Props {
  axis: RatingAxis;
  rating: WalkthroughRating | null;
  state: CellState;
  blocks: WalkthroughBlock[];
  onJump: (blockId: string) => void;
  /** Bound upward for the grid's arrow-key navigation. */
  triggerRef?: HTMLElement | null;
}

let { axis, rating, state, blocks, onJump, triggerRef = $bindable(null) }: Props = $props();

const axisLabel = $derived(RATING_AXIS_LABELS[axis]);

const verdictClass = $derived(rating ? `cell--${rating.verdict}` : `cell--pending`);

const statusText = $derived.by(() => {
  if (state === "queued") return "Queued";
  if (state === "running") return "Running…";
  if (!rating) return "—";
  if (rating.verdict === "pass") return "Pass";
  if (rating.verdict === "concern") return "Needs attention";
  return "Blocker";
});

const synthesisLine = $derived(rating ? synthesize(rating) : "");

const ariaLabel = $derived.by(() => {
  if (state === "queued") return `${axisLabel}: queued`;
  if (state === "running") return `${axisLabel}: running`;
  if (!rating) return `${axisLabel}: unknown`;
  return `${axisLabel}: ${rating.verdict} with ${rating.confidence} confidence`;
});

// Ratings carry no id or timestamp, so a verdict is identified by its
// content: a rating edited later lands again; a remount or a re-shown tab
// does not.
const verdictKey = $derived(
  rating ? `rating:${axis}:${rating.verdict}:${rating.confidence}:${rating.rationale}` : null,
);

const isDisabled = $derived(state !== "resolved");
</script>

<div class="cell {verdictClass}" data-state={state}>
    <Popover.Root>
        <Popover.Trigger
            class="cell-trigger"
            disabled={isDisabled}
            aria-disabled={isDisabled}
            aria-label={ariaLabel}
            bind:ref={triggerRef}
        >
            <span
                class="cell-body"
                {@attach verdictKey !== null &&
                    fromAction(enterOnce, (): EnterParams => ({ key: `${verdictKey}:drop`, look: "drop" }))}
            >
                <span class="cell-label">{axisLabel}</span>

                <span class="cell-status">
                    <span class="cell-status-icon" aria-hidden="true">
                        {#if state === "queued"}
                            <span class="icon-queued">
                                <Spinner size={13} class="motion-essential-spin" />
                            </span>
                        {:else if state === "running"}
                            <span class="icon-running">
                                <Spinner size={13} class="motion-essential-spin" />
                            </span>
                        {:else if rating && verdictKey}
                            <span
                                class="icon-resolved"
                                use:enterOnce={{ key: `${verdictKey}:pop`, look: "pop" }}
                            >
                                {#if rating.verdict === "pass"}
                                    <Check size={13} />
                                {:else if rating.verdict === "concern"}
                                    <Warning size={13} weight="fill" />
                                {:else}
                                    <XCircle size={13} weight="fill" />
                                {/if}
                            </span>
                        {/if}
                    </span>
                    <span class="cell-status-text">{statusText}</span>
                </span>

                {#if synthesisLine}
                    <span class="cell-synthesis">{synthesisLine}</span>
                {/if}
            </span>
        </Popover.Trigger>

        <Popover.Content
            class="rating-cell-popover"
            side="bottom"
            align="start"
            sideOffset={8}
        >
            {#if rating}
                <!-- Popover.Content portals to <body>, out of reach of the
                     cell's verdict tokens, so the body re-applies them. -->
                <div class="popover-body cell--{rating.verdict}">
                    <RatingExpandedBody {rating} {blocks} {onJump} />
                </div>
            {/if}
        </Popover.Content>
    </Popover.Root>
</div>

<style>
    .cell {
        --c-rating-bg: transparent;
        --c-rating-border: var(--color-border);
        --c-rating-icon: var(--color-text-muted);
        --c-rating-label: var(--color-text-primary);
        --c-rating-axis: var(--color-text-primary);

        position: relative;
        display: flex;
        min-height: 96px;
        background: var(--color-bg-secondary);
    }

    .cell--pass {
        --c-rating-bg: var(--color-score-pass-bg);
        --c-rating-border: var(--color-score-pass-border);
        --c-rating-icon: var(--color-score-pass-icon);
        --c-rating-label: var(--color-score-pass-label);
        --c-rating-axis: var(--color-score-pass-axis);
    }

    .cell--concern {
        --c-rating-bg: var(--color-score-concern-bg);
        --c-rating-border: var(--color-score-concern-border);
        --c-rating-icon: var(--color-score-concern-icon);
        --c-rating-label: var(--color-score-concern-label);
        --c-rating-axis: var(--color-score-concern-axis);
    }

    .cell--blocker {
        --c-rating-bg: var(--color-score-blocker-bg);
        --c-rating-border: var(--color-score-blocker-border);
        --c-rating-icon: var(--color-score-blocker-icon);
        --c-rating-label: var(--color-score-blocker-label);
        --c-rating-axis: var(--color-score-blocker-axis);
    }

    :global(.cell-trigger) {
        display: flex;
        width: 100%;
        padding: 12px 14px;
        background: transparent;
        border: none;
        border-radius: 0;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
        transition:
            background var(--duration-snap) var(--ease-soft),
            opacity var(--duration-snap) var(--ease-soft);
    }

    :global(.cell-trigger:disabled),
    :global(.cell-trigger[aria-disabled="true"]) {
        cursor: default;
    }

    :global(.cell-trigger:focus-visible) {
        outline: 2px solid var(--color-accent);
        outline-offset: -2px;
    }

    :global(.cell-trigger:hover:not(:disabled):not([aria-disabled="true"])) {
        background: color-mix(
            in srgb,
            var(--c-rating-bg) 55%,
            transparent
        );
    }

    .cell-body {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        width: 100%;
    }

    .cell-label {
        font-family: var(--font-mono);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--color-text-muted);
        line-height: 1;
    }

    .cell[data-state="queued"] .cell-label,
    .cell[data-state="running"] .cell-label {
        opacity: 0.6;
    }

    .cell-status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-family: var(--font-sans);
        font-size: 14px;
        font-weight: 600;
        color: var(--c-rating-label);
        line-height: 1.2;
    }

    .cell[data-state="queued"] .cell-status,
    .cell[data-state="running"] .cell-status {
        color: var(--color-text-muted);
    }

    .cell-status-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--c-rating-icon);
    }

    .icon-queued {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        opacity: 0.4;
    }

    .icon-queued :global(svg) {
        display: block;
    }

    .icon-running {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--color-accent);
    }

    .icon-resolved {
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    .icon-resolved :global(svg) {
        display: block;
    }

    .cell-status-text {
        letter-spacing: 0.01em;
    }

    .cell-synthesis {
        font-family: var(--font-mono);
        font-size: 11.5px;
        color: var(--color-text-muted);
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
        min-width: 0;
        align-self: stretch;
    }

    .cell[data-state="queued"] :global(.cell-trigger) {
        opacity: 0.55;
    }

    .cell[data-state="running"] :global(.cell-trigger) {
        opacity: 0.85;
        animation: cell-pulse var(--duration-pulse) var(--ease-soft) infinite;
    }

    @keyframes cell-pulse {
        0%,
        100% {
            background: transparent;
        }
        50% {
            background: color-mix(
                in srgb,
                var(--color-accent) 6%,
                transparent
            );
        }
    }

    /* Bits-ui's default popover caps at w-72 (288px), too tight for the
       expanded rating body. */
    :global(.rating-cell-popover) {
        width: min(420px, 90vw) !important;
        max-height: min(520px, 70vh);
        overflow-y: auto;
        padding: 0;
    }
</style>
