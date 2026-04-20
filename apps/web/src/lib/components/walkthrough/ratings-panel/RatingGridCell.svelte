<script lang="ts">
    import { Check, AlertCircle, X, Loader2 } from "@lucide/svelte";
    import * as Popover from "$lib/components/ui/popover";
    import type {
        WalkthroughRating,
        WalkthroughBlock,
        RatingAxis,
    } from "@revv/shared";
    import { RATING_AXIS_LABELS } from "@revv/shared";
    import RatingExpandedBody from "./RatingExpandedBody.svelte";
    import { synthesize } from "./format-synthesis";

    /** Mirrors `RowState` from RatingTestRow — the two views share the same
     *  three lifecycle states. Duplicated as a local type alias so we don't
     *  re-export from the list row and couple these components unnecessarily. */
    export type CellState = "queued" | "running" | "resolved";

    interface Props {
        axis: RatingAxis;
        rating: WalkthroughRating | null;
        state: CellState;
        /** Full ordered block list — forwarded to RatingExpandedBody so the
         *  "step N" chips resolve to the block's global index. */
        blocks: WalkthroughBlock[];
        /** Jump-to-block handler — forwarded to RatingExpandedBody. */
        onJump: (blockId: string) => void;
        /** Grid-level keyboard nav binds upward so the 2-D arrow-key handler
         *  on the orchestrator can call focus() against this trigger. */
        triggerRef?: HTMLElement | null;
    }

    let {
        axis,
        rating,
        state,
        blocks,
        onJump,
        triggerRef = $bindable(null),
    }: Props = $props();

    const axisLabel = $derived(RATING_AXIS_LABELS[axis]);

    // Verdict class — same vocabulary as RatingTestRow (`cell--pass`,
    // `cell--concern`, `cell--blocker`, `cell--pending`) so the existing
    // `--c-rating-*` CSS-variable pattern re-skins for free.
    const verdictClass = $derived(
        rating ? `cell--${rating.verdict}` : `cell--pending`,
    );

    // Status row text — the verdict expressed in human-readable form. Pending
    // states get friendlier labels than the raw lifecycle value so a queued
    // cell reads as "Queued" rather than "queued".
    const statusText = $derived.by(() => {
        if (state === "queued") return "Queued";
        if (state === "running") return "Running…";
        if (!rating) return "—";
        if (rating.verdict === "pass") return "Pass";
        if (rating.verdict === "concern") return "Needs attention";
        return "Blocker";
    });

    // Smart-synthesis detail line. Empty string when there's nothing useful to
    // say (queued/running, or a pass with no rationale) — the template checks
    // truthiness so we don't emit an empty <div>.
    const synthesisLine = $derived.by(() => {
        if (!rating) return "";
        return synthesize(rating);
    });

    // Spoken semantics identical to RatingTestRow so VoiceOver / JAWS users
    // get the same phrasing regardless of which view they land in.
    const ariaLabel = $derived.by(() => {
        if (state === "queued") return `${axisLabel}: queued`;
        if (state === "running") return `${axisLabel}: running`;
        if (!rating) return `${axisLabel}: unknown`;
        return `${axisLabel}: ${rating.verdict} with ${rating.confidence} confidence`;
    });

    // Only resolved cells open. Queued/running triggers render as inert
    // buttons (native `disabled` + `aria-disabled`) — clicking them does
    // nothing and the popover never opens, matching the list-view behavior.
    const isDisabled = $derived(state !== "resolved");
</script>

<div
    class="cell {verdictClass}"
    data-state={state}
    data-verdict={rating?.verdict ?? "pending"}
    aria-busy={state === "running" ? "true" : undefined}
>
        <Popover.Root>
        <Popover.Trigger
            class="cell-trigger"
            disabled={isDisabled}
            aria-disabled={isDisabled}
            aria-label={ariaLabel}
            bind:ref={triggerRef}
        >
            <span class="cell-label">{axisLabel}</span>

            <span class="cell-status">
                <span class="cell-status-icon" aria-hidden="true">
                    {#if state === "queued"}
                        <span class="icon-queued">
                            <Loader2 size={13} />
                        </span>
                    {:else if state === "running"}
                        <span class="icon-running">
                            <Loader2 size={13} />
                        </span>
                    {:else if rating?.verdict === "pass"}
                        <span class="icon-resolved">
                            <Check size={13} />
                        </span>
                    {:else if rating?.verdict === "concern"}
                        <span class="icon-resolved">
                            <AlertCircle size={13} />
                        </span>
                    {:else if rating?.verdict === "blocker"}
                        <span class="icon-resolved">
                            <X size={13} />
                        </span>
                    {/if}
                </span>
                <span class="cell-status-text">{statusText}</span>
            </span>

            {#if synthesisLine}
                <span class="cell-synthesis">{synthesisLine}</span>
            {/if}
        </Popover.Trigger>

        <Popover.Content
            class="rating-cell-popover"
            side="bottom"
            align="start"
            sideOffset={8}
        >
            {#if rating}
                <!-- Re-apply the verdict class INSIDE the popover so the
                     `--c-rating-bg`/`--c-rating-icon` tokens RatingExpandedBody
                     reads get set correctly. Necessary because Popover.Content
                     portals its DOM to document.body, breaking the CSS variable
                     cascade from the cell container. -->
                <div class="popover-body cell--{rating.verdict}">
                    <RatingExpandedBody
                        {rating}
                        {blocks}
                        {onJump}
                        showTitle
                    />
                </div>
            {/if}
        </Popover.Content>
    </Popover.Root>
</div>

<style>
    .cell {
        /* Verdict palette — overridden by `.cell--{verdict}` below. Same
           token names as RatingTestRow so the palette stays in one
           vocabulary and future re-theming touches both views. */
        --c-rating-bg: transparent;
        --c-rating-border: var(--color-border);
        --c-rating-icon: var(--color-text-muted);
        --c-rating-label: var(--color-text-primary);
        --c-rating-axis: var(--color-text-primary);

        position: relative;
        display: flex;
        /* Single cell body — the trigger fills it. A CSS grid row/column
           slot provides the outer layout so the cell just needs to stretch. */
        min-height: 96px;
        background: var(--color-bg-secondary);
    }

    /* ── Verdict color palettes ──────────────────────────────────── */

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

    /* ── Cell trigger (clickable button) ─────────────────────────── */

    :global(.cell-trigger) {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
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
        /* Faint verdict-tinted wash on hover — matches the list view. */
        background: color-mix(
            in srgb,
            var(--c-rating-bg) 55%,
            transparent
        );
    }

    /* ── Label (uppercase mono axis name) ────────────────────────── */

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

    /* ── Status row (icon + verdict text) ────────────────────────── */

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
        opacity: 0.4;
    }

    .icon-running {
        display: inline-flex;
        animation: spin 900ms linear infinite;
        color: var(--color-accent);
    }

    .icon-resolved {
        display: inline-flex;
        animation: icon-in 180ms var(--ease-out-expo) 1;
    }

    .cell-status-text {
        /* Tabular numerals aren't strictly needed here (no digits) but
           keeping the token consistent with other status chips. */
        letter-spacing: 0.01em;
    }

    /* ── Synthesis line (muted detail) ───────────────────────────── */

    .cell-synthesis {
        font-family: var(--font-mono);
        font-size: 11.5px;
        color: var(--color-text-muted);
        line-height: 1.35;
        /* Clamp to a single line — citation summaries are structured and
           short, and rationale fragments have already been truncated in
           format-synthesis. A second line would make the grid cells uneven
           heights and pull the eye around. */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
        min-width: 0;
        align-self: stretch;
    }

    /* ── Lifecycle animations ────────────────────────────────────── */

    .cell[data-state="queued"] :global(.cell-trigger) {
        opacity: 0.55;
    }

    .cell[data-state="running"] :global(.cell-trigger) {
        opacity: 0.85;
        /* Subtle background pulse so the eye can pick the running cell out
           of the grid without having to interpret the spinner. */
        animation: cell-pulse 1.4s ease-in-out infinite;
    }

    .cell[data-state="resolved"] :global(.cell-trigger) {
        animation: cell-resolve 220ms var(--ease-out-expo) 1;
    }

    @keyframes spin {
        from {
            transform: rotate(0deg);
        }
        to {
            transform: rotate(360deg);
        }
    }

    @keyframes icon-in {
        from {
            transform: scale(0.85);
            opacity: 0;
        }
        to {
            transform: scale(1);
            opacity: 1;
        }
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

    @keyframes cell-resolve {
        from {
            transform: translateY(-1px);
            opacity: 0.6;
        }
        to {
            transform: translateY(0);
            opacity: 1;
        }
    }

    /* ── Popover content overrides ───────────────────────────────── */
    /* Bits-ui's default popover caps at w-72 (288px) which is too tight for
       the expanded rating body (rationale + details + citations + chips).
       Override via a global selector on the class we pass in. */
    :global(.rating-cell-popover) {
        width: min(420px, 90vw) !important;
        max-height: min(520px, 70vh);
        overflow-y: auto;
        padding: 0;
    }

    /* ── Reduced motion ──────────────────────────────────────────── */

    @media (prefers-reduced-motion: reduce) {
        .icon-running {
            animation: none;
        }
        .icon-resolved {
            animation: none;
        }
        .cell[data-state="running"] :global(.cell-trigger) {
            animation: none;
        }
        .cell[data-state="resolved"] :global(.cell-trigger) {
            animation: none;
        }
    }
</style>
