<script lang="ts">
    import {
        Check,
        AlertCircle,
        X,
        Loader2,
        ChevronRight,
    } from "@lucide/svelte";
    import * as Collapsible from "$lib/components/ui/collapsible";
    import type {
        WalkthroughRating,
        WalkthroughBlock,
        RatingAxis,
        Confidence,
    } from "@revv/shared";
    import { RATING_AXIS_LABELS } from "@revv/shared";
    import RatingExpandedBody from "./RatingExpandedBody.svelte";

    export type RowState = "queued" | "running" | "resolved";

    interface Props {
        axis: RatingAxis;
        rating: WalkthroughRating | null;
        state: RowState;
        /** Full ordered block list — needed to resolve a blockId to a step N. */
        blocks: WalkthroughBlock[];
        open: boolean;
        /** Duration label for the chip. Either a formatted string or "—" for cached. */
        durationLabel: string;
        /** Triggered when user clicks the row header. */
        onToggle: () => void;
        /** Jump to walkthrough block (from block-link chips). */
        onJump: (blockId: string) => void;
        /** Per-row focus/navigation — the trigger element, bound upward so the
         *  orchestrator can manage ArrowUp/ArrowDown/Home/End navigation. */
        triggerRef?: HTMLElement | null;
    }

    let {
        axis,
        rating,
        state,
        blocks,
        open,
        durationLabel,
        onToggle,
        onJump,
        triggerRef = $bindable(null),
    }: Props = $props();

    // Friendly confidence shorthand used in the row chip. Falls back to "" for
    // queued/running rows — they don't have a confidence value yet.
    const confidenceLabels: Record<Confidence, string> = {
        low: "LOW",
        medium: "MED",
        high: "HIGH",
    };

    const confidenceShort: Record<Confidence, string> = {
        low: "L",
        medium: "M",
        high: "H",
    };

    // The row's visual "verdict class" drives both the gutter color and the
    // flash keyframe. For queued/running we use a neutral class so the gutter
    // reads as "not yet scored" rather than accidentally green.
    const verdictClass = $derived(
        rating ? `row--${rating.verdict}` : `row--pending`,
    );

    const axisLabel = $derived(RATING_AXIS_LABELS[axis]);

    // Rationale preview — "queued" / "running…" placeholders so the row has
    // something to say before the rating resolves. Past-tense for queued, with
    // a trailing ellipsis for running to telegraph activity.
    const rationalePreview = $derived.by(() => {
        if (state === "queued") return "queued";
        if (state === "running") return "running…";
        return rating?.rationale ?? "";
    });

    // Vitest-style spoken label so a screen-reader user hears e.g.
    // "Correctness: passed with high confidence" rather than just "button".
    const ariaLabel = $derived.by(() => {
        if (state === "queued") return `${axisLabel}: queued`;
        if (state === "running") return `${axisLabel}: running`;
        if (!rating) return `${axisLabel}: unknown`;
        return `${axisLabel}: ${rating.verdict} with ${rating.confidence} confidence`;
    });

    const isDisabled = $derived(state !== "resolved");
</script>

<li
    class="row {verdictClass}"
    data-state={state}
    data-verdict={rating?.verdict ?? "pending"}
    aria-busy={state === "running" ? "true" : undefined}
>
    <Collapsible.Root
        {open}
        onOpenChange={(next: boolean) => {
            // Controlled: route every user-initiated change through onToggle so
            // the orchestrator can apply its expand-all snapshot logic. We
            // ignore calls while disabled (queued/running) defensively — the
            // Trigger should already be inert in those states.
            if (isDisabled) return;
            if (next !== open) onToggle();
        }}
    >
        <Collapsible.Trigger
            class="row-trigger"
            disabled={isDisabled}
            aria-disabled={isDisabled}
            aria-label={ariaLabel}
            bind:ref={triggerRef}
        >
            <span class="row-gutter" aria-hidden="true"></span>

            <span class="row-icon" aria-hidden="true">
                {#if state === "queued"}
                    <span class="icon-queued">
                        <Loader2 size={14} />
                    </span>
                {:else if state === "running"}
                    <span class="icon-running">
                        <Loader2 size={14} />
                    </span>
                {:else if rating?.verdict === "pass"}
                    <span class="icon-resolved">
                        <Check size={14} />
                    </span>
                {:else if rating?.verdict === "concern"}
                    <span class="icon-resolved">
                        <AlertCircle size={14} />
                    </span>
                {:else if rating?.verdict === "blocker"}
                    <span class="icon-resolved">
                        <X size={14} />
                    </span>
                {/if}
            </span>

            <span class="row-axis">{axisLabel}</span>

            {#if !open}
                <span
                    class="row-rationale"
                    class:row-rationale--muted={state !== "resolved"}
                >
                    {rationalePreview}
                </span>
            {:else}
                <span class="row-rationale row-rationale--hidden" aria-hidden="true"></span>
            {/if}

            <span
                class="row-confidence"
                class:row-confidence--hidden={!rating}
            >
                {#if rating}
                    <span class="conf-full">{confidenceLabels[rating.confidence]}</span>
                    <span class="conf-short" aria-hidden="true">{confidenceShort[rating.confidence]}</span>
                {/if}
            </span>

            <span
                class="row-duration"
                class:row-duration--hidden={state !== "resolved"}
            >
                {durationLabel}
            </span>

            <span
                class="row-chevron"
                class:row-chevron--open={open}
                aria-hidden="true"
            >
                <ChevronRight size={14} />
            </span>
        </Collapsible.Trigger>

        <Collapsible.Content>
            {#if rating}
                <RatingExpandedBody {rating} {blocks} {onJump} />
            {/if}
        </Collapsible.Content>
    </Collapsible.Root>
</li>

<style>
    .row {
        --row-height: 36px;
        --gutter-w: 2px;

        /* Verdict palette — overridden by `.row--{verdict}` below. */
        --c-rating-bg: transparent;
        --c-rating-border: var(--color-border);
        --c-rating-icon: var(--color-text-muted);
        --c-rating-label: var(--color-text-primary);
        --c-rating-axis: var(--color-text-primary);
        --c-rating-conf-bg: color-mix(
            in srgb,
            var(--color-text-muted) 10%,
            transparent
        );
        --c-rating-conf: var(--color-text-muted);
        --c-gutter-flash: var(--c-rating-icon);

        list-style: none;
        position: relative;
        display: block;
    }

    /* ── Verdict color palettes ──────────────────────────────────── */

    .row--pass {
        --c-rating-bg: var(--color-score-pass-bg);
        --c-rating-border: var(--color-score-pass-border);
        --c-rating-icon: var(--color-score-pass-icon);
        --c-rating-label: var(--color-score-pass-label);
        --c-rating-axis: var(--color-score-pass-axis);
        --c-rating-conf-bg: var(--color-score-pass-conf-bg);
        --c-rating-conf: var(--color-score-pass-conf);
        --c-gutter-flash: color-mix(
            in srgb,
            var(--color-score-pass-icon) 70%,
            white
        );
    }

    .row--concern {
        --c-rating-bg: var(--color-score-concern-bg);
        --c-rating-border: var(--color-score-concern-border);
        --c-rating-icon: var(--color-score-concern-icon);
        --c-rating-label: var(--color-score-concern-label);
        --c-rating-axis: var(--color-score-concern-axis);
        --c-rating-conf-bg: var(--color-score-concern-conf-bg);
        --c-rating-conf: var(--color-score-concern-conf);
        --c-gutter-flash: color-mix(
            in srgb,
            var(--color-score-concern-icon) 70%,
            white
        );
    }

    .row--blocker {
        --c-rating-bg: var(--color-score-blocker-bg);
        --c-rating-border: var(--color-score-blocker-border);
        --c-rating-icon: var(--color-score-blocker-icon);
        --c-rating-label: var(--color-score-blocker-label);
        --c-rating-axis: var(--color-score-blocker-axis);
        --c-rating-conf-bg: var(--color-score-blocker-conf-bg);
        --c-rating-conf: var(--color-score-blocker-conf);
        --c-gutter-flash: color-mix(
            in srgb,
            var(--color-score-blocker-icon) 70%,
            white
        );
    }

    /* ── Row trigger (clickable header) ─────────────────────────── */

    :global(.row-trigger) {
        display: grid;
        /* icon (2ch) · axis (auto) · rationale (1fr) · conf (auto) · dur (auto) · chevron (auto) */
        grid-template-columns:
            2ch
            minmax(max-content, auto)
            minmax(0, 1fr)
            auto
            auto
            16px;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-height: 36px;
        padding: 0 10px 0 16px;
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

    :global(.row-trigger:disabled),
    :global(.row-trigger[aria-disabled="true"]) {
        cursor: default;
    }

    :global(.row-trigger:focus-visible) {
        outline: 2px solid var(--color-accent);
        outline-offset: -2px;
    }

    :global(.row-trigger:hover:not(:disabled):not([aria-disabled="true"])) {
        background: color-mix(
            in srgb,
            var(--c-rating-bg) 50%,
            transparent
        );
    }

    /* ── Left gutter ────────────────────────────────────────────── */

    .row-gutter {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: var(--gutter-w);
        background: var(--c-rating-icon);
        transition: background var(--duration-quick) var(--ease-soft);
    }

    .row[data-state="queued"] .row-gutter {
        background: var(--color-border);
    }

    .row[data-state="running"] .row-gutter {
        animation: pulse-gutter 1.2s ease-in-out infinite;
    }

    /* When the row transitions to resolved, flash the gutter briefly with a
       brighter variant of the verdict color. Runs once via iteration-count 1. */
    .row[data-state="resolved"] .row-gutter {
        animation: gutter-flash 320ms var(--ease-out-expo) 1;
    }

    @keyframes pulse-gutter {
        0%,
        100% {
            background: var(--color-border);
        }
        50% {
            background: var(--color-accent);
        }
    }

    @keyframes gutter-flash {
        0% {
            background: var(--c-gutter-flash);
            box-shadow: 0 0 6px
                color-mix(in srgb, var(--c-gutter-flash) 50%, transparent);
        }
        100% {
            background: var(--c-rating-icon);
            box-shadow: none;
        }
    }

    /* ── Icon column ────────────────────────────────────────────── */

    .row-icon {
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

    /* ── Text columns ────────────────────────────────────────────── */

    .row-axis {
        font-family: var(--font-mono);
        font-size: 13px;
        font-weight: 600;
        color: var(--c-rating-axis);
        white-space: nowrap;
        letter-spacing: 0.01em;
    }

    .row[data-state="queued"] .row-axis {
        color: var(--color-text-muted);
    }

    .row-rationale {
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
    }

    .row-rationale--hidden {
        visibility: hidden;
    }

    /* While queued/running, the preview text dims further and italicizes so
       the row feels "not yet informative" without going fully invisible. */
    .row-rationale--muted {
        opacity: 0.7;
        font-style: italic;
    }

    /* Theatrical pulse when resolving — make the rationale text "land". */
    .row[data-state="resolved"] .row-rationale {
        animation: rationale-pulse 220ms ease-out 1;
    }

    @keyframes rationale-pulse {
        0% {
            opacity: 0.6;
        }
        100% {
            opacity: 1;
        }
    }

    /* ── Confidence chip ─────────────────────────────────────────── */

    .row-confidence {
        display: inline-flex;
        align-items: center;
        font-family: var(--font-mono);
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: var(--c-rating-conf);
        background: var(--c-rating-conf-bg);
        padding: 2px 6px;
        border-radius: 4px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }

    .row-confidence--hidden {
        visibility: hidden;
    }

    .conf-short {
        display: none;
    }

    /* ── Duration chip ───────────────────────────────────────────── */

    .row-duration {
        font-family: var(--font-mono);
        font-size: 11px;
        color: var(--color-text-muted);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }

    .row-duration--hidden {
        visibility: hidden;
    }

    /* ── Chevron ─────────────────────────────────────────────────── */

    .row-chevron {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--color-text-muted);
        transition: transform var(--duration-snap) var(--ease-out-expo);
    }

    .row-chevron--open {
        transform: rotate(90deg);
    }

    /* ── Row lifecycle state opacity ─────────────────────────────── */

    .row[data-state="queued"] :global(.row-trigger) {
        opacity: 0.45;
    }

    .row[data-state="running"] :global(.row-trigger) {
        opacity: 0.75;
    }

    .row[data-state="resolved"] :global(.row-trigger) {
        animation: row-resolve 180ms var(--ease-out-expo) 1;
    }

    @keyframes row-resolve {
        0% {
            transform: translateX(-2px);
            opacity: 0.7;
        }
        100% {
            transform: translateX(0);
            opacity: 1;
        }
    }

    /* ── Narrow width (RequestChanges sidebar) ──────────────────── */

    @container ratings (max-width: 420px) {
        :global(.row-trigger) {
            grid-template-columns:
                2ch
                minmax(max-content, auto)
                minmax(0, 1fr)
                auto
                16px;
        }
        .row-duration {
            display: none;
        }
        /* Swap full confidence label for single-letter chip. */
        .conf-full {
            display: none;
        }
        .conf-short {
            display: inline;
            padding: 0 2px;
        }
        .row-confidence {
            padding: 2px 4px;
        }
    }

    /* ── Reduced motion ──────────────────────────────────────────── */

    @media (prefers-reduced-motion: reduce) {
        .icon-running {
            animation: none;
        }
        .icon-resolved {
            animation: none;
        }
        .row[data-state="running"] .row-gutter,
        .row[data-state="resolved"] .row-gutter {
            animation: none;
        }
        .row[data-state="resolved"] :global(.row-trigger) {
            animation: none;
        }
        .row[data-state="resolved"] .row-rationale {
            animation: none;
        }
        .row-chevron {
            transition: none;
        }
    }
</style>
