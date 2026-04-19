<script lang="ts">
    import { RATING_AXES } from "@revv/shared";
    import { formatDuration } from "./format-duration";

    interface Counts {
        pass: number;
        concern: number;
        blocker: number;
        total: number;
        pending: number;
    }

    interface Props {
        counts: Counts;
        /** Total elapsed across all ratings (ms), or null while streaming / for
         *  cached replays where a 0ms reading would be misleading. */
        totalElapsedMs: number | null;
        /** True iff all axes resolved as pass. Drives the "all checks passed"
         *  celebration treatment. */
        allPassed: boolean;
    }

    let { counts, totalElapsedMs, allPassed }: Props = $props();
</script>

<div
    class="summary-footer"
    class:summary-footer--passed={allPassed}
    aria-live="off"
>
    <span class="footer-line">
        Tests: <strong>{counts.pass} passed</strong>,
        <strong
            >{counts.concern}
            {counts.concern === 1 ? "concern" : "concerns"}</strong
        >,
        <strong
            >{counts.blocker}
            {counts.blocker === 1 ? "blocker" : "blockers"}</strong
        >
        · {counts.total}/{RATING_AXES.length}
        {#if totalElapsedMs !== null}
            · {formatDuration(totalElapsedMs)}
        {/if}
    </span>
    {#if allPassed}
        <span class="footer-passed-label">All checks passed</span>
    {/if}
</div>

<style>
    .summary-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 12px 10px;
        border-top: 1px solid var(--color-border);
        font-family: var(--font-mono);
        font-size: 11.5px;
        color: var(--color-text-muted);
        font-variant-numeric: tabular-nums;
        flex-wrap: wrap;
        transition: background var(--duration-quick) var(--ease-soft);
    }

    .summary-footer strong {
        color: var(--color-text-primary);
        font-weight: 600;
    }

    .footer-line {
        letter-spacing: 0.01em;
    }

    /* All-green celebration state — faint green wash + one-time bounce. */
    .summary-footer--passed {
        background: color-mix(
            in srgb,
            var(--color-score-pass-bg) 70%,
            transparent
        );
        color: var(--color-score-pass-label);
        animation: footer-bounce 500ms var(--ease-out-expo) 1;
    }

    .summary-footer--passed strong {
        color: var(--color-score-pass-label);
    }

    .footer-passed-label {
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--color-score-pass-label);
    }

    @keyframes footer-bounce {
        0% {
            transform: scale(1);
        }
        50% {
            transform: scale(1.02);
        }
        100% {
            transform: scale(1);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .summary-footer--passed {
            animation: none;
        }
    }
</style>
