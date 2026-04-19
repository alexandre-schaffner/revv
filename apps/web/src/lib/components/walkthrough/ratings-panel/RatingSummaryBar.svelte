<script lang="ts">
    import {
        Terminal,
        Check,
        AlertCircle,
        X,
        Loader2,
        ChevronsDownUp,
        ChevronsUpDown,
        Filter,
    } from "@lucide/svelte";
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
        /** Running count — number of axes currently in the `running` lifecycle state. */
        runningCount: number;
        /** Total elapsed time for all ratings combined (ms). Only shown when complete. */
        totalElapsedMs: number | null;
        /** When true, the expand-all toggle is active. null = per-row state. */
        expandAll: boolean | null;
        onlyFailing: boolean;
        onToggleExpandAll: () => void;
        onToggleOnlyFailing: () => void;
    }

    let {
        counts,
        runningCount,
        totalElapsedMs,
        expandAll,
        onlyFailing,
        onToggleExpandAll,
        onToggleOnlyFailing,
    }: Props = $props();

    // The "Expand all" button flips its label to "Collapse all" when every row
    // is visually expanded. With tri-state logic (true/false/null) we treat any
    // non-true value as "not expanded" so the first click expands everything.
    const expandLabel = $derived(expandAll === true ? "Collapse all" : "Expand all");
</script>

<div class="summary-bar">
    <div class="summary-left">
        <span class="spec-icon" aria-hidden="true">
            <Terminal size={14} />
        </span>
        <span class="spec-title">Scores</span>

        <div class="count-pills" role="status" aria-live="polite">
            <span
                class="count-pill count-pill--pass"
                class:count-pill--zero={counts.pass === 0}
                title="{counts.pass} passed"
            >
                <Check size={11} aria-hidden="true" />
                <span class="count-num">{counts.pass}</span>
                <span class="count-label">passed</span>
            </span>
            <span
                class="count-pill count-pill--concern"
                class:count-pill--zero={counts.concern === 0}
                title="{counts.concern} concern{counts.concern === 1 ? '' : 's'}"
            >
                <AlertCircle size={11} aria-hidden="true" />
                <span class="count-num">{counts.concern}</span>
                <span class="count-label"
                    >{counts.concern === 1 ? "concern" : "concerns"}</span
                >
            </span>
            <span
                class="count-pill count-pill--blocker"
                class:count-pill--zero={counts.blocker === 0}
                title="{counts.blocker} blocker{counts.blocker === 1 ? '' : 's'}"
            >
                <X size={11} aria-hidden="true" />
                <span class="count-num">{counts.blocker}</span>
                <span class="count-label"
                    >{counts.blocker === 1 ? "blocker" : "blockers"}</span
                >
            </span>

            {#if runningCount > 0}
                <span class="count-pill count-pill--running" title="{runningCount} running">
                    <span class="spinner" aria-hidden="true">
                        <Loader2 size={11} />
                    </span>
                    <span class="count-label">{runningCount} running</span>
                </span>
            {/if}

            {#if totalElapsedMs !== null}
                <span class="count-elapsed" title="Total elapsed">
                    · {formatDuration(totalElapsedMs)}
                </span>
            {/if}
        </div>
    </div>

    <div class="summary-controls">
        <button
            type="button"
            class="ctrl-btn"
            onclick={onToggleExpandAll}
            aria-pressed={expandAll === true}
        >
            <span class="ctrl-icon" aria-hidden="true">
                {#if expandAll === true}
                    <ChevronsDownUp size={12} />
                {:else}
                    <ChevronsUpDown size={12} />
                {/if}
            </span>
            <span class="ctrl-label">{expandLabel}</span>
        </button>
        <button
            type="button"
            class="ctrl-btn"
            class:ctrl-btn--pressed={onlyFailing}
            onclick={onToggleOnlyFailing}
            aria-pressed={onlyFailing}
        >
            <span class="ctrl-icon" aria-hidden="true">
                <Filter size={12} />
            </span>
            <span class="ctrl-label">Only failing</span>
        </button>
    </div>
</div>

<div class="summary-divider" aria-hidden="true"></div>

<style>
    .summary-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        font-family: var(--font-mono);
        flex-wrap: wrap;
    }

    .summary-left {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        min-width: 0;
    }

    .spec-icon {
        display: inline-flex;
        align-items: center;
        color: var(--color-text-muted);
    }

    .spec-title {
        font-family: var(--font-mono);
        font-size: 13px;
        font-weight: 600;
        color: var(--color-text-primary);
        letter-spacing: 0.01em;
    }

    .count-pills {
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: var(--font-mono);
        font-size: 11.5px;
        flex-wrap: wrap;
    }

    .count-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        border-radius: 4px;
        font-variant-numeric: tabular-nums;
        transition: opacity var(--duration-snap) var(--ease-soft);
    }

    .count-pill--zero {
        opacity: 0.3;
    }

    .count-pill--pass {
        color: var(--color-score-pass-label);
        background: color-mix(in srgb, var(--color-score-pass-bg) 60%, transparent);
    }

    .count-pill--concern {
        color: var(--color-score-concern-label);
        background: color-mix(
            in srgb,
            var(--color-score-concern-bg) 60%,
            transparent
        );
    }

    .count-pill--blocker {
        color: var(--color-score-blocker-label);
        background: color-mix(
            in srgb,
            var(--color-score-blocker-bg) 60%,
            transparent
        );
    }

    .count-pill--running {
        color: var(--color-text-secondary);
        background: color-mix(
            in srgb,
            var(--color-bg-tertiary) 80%,
            transparent
        );
    }

    .count-num {
        font-weight: 700;
    }

    .count-label {
        font-weight: 500;
        letter-spacing: 0.01em;
    }

    .count-elapsed {
        font-family: var(--font-mono);
        font-size: 11.5px;
        color: var(--color-text-muted);
        font-variant-numeric: tabular-nums;
    }

    .spinner {
        display: inline-flex;
        animation: spin 900ms linear infinite;
    }

    @keyframes spin {
        from {
            transform: rotate(0deg);
        }
        to {
            transform: rotate(360deg);
        }
    }

    .summary-controls {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .ctrl-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 8px;
        border-radius: 4px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--color-text-muted);
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        cursor: pointer;
        transition:
            background var(--duration-snap) var(--ease-soft),
            color var(--duration-snap) var(--ease-soft),
            border-color var(--duration-snap) var(--ease-soft);
    }

    .ctrl-btn:hover {
        background: color-mix(
            in srgb,
            var(--color-text-primary) 8%,
            transparent
        );
        color: var(--color-text-primary);
    }

    .ctrl-btn:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
    }

    .ctrl-btn--pressed {
        background: var(--color-score-concern-bg);
        color: var(--color-score-concern-label);
        border-color: color-mix(
            in srgb,
            var(--color-score-concern-border) 40%,
            transparent
        );
    }

    .ctrl-btn--pressed:hover {
        background: color-mix(
            in srgb,
            var(--color-score-concern-bg) 80%,
            var(--color-text-primary) 5%
        );
    }

    .ctrl-icon {
        display: inline-flex;
        align-items: center;
    }

    .summary-divider {
        height: 1px;
        background: var(--color-border);
        opacity: 0.6;
        margin: 0;
    }

    @media (prefers-reduced-motion: reduce) {
        .spinner {
            animation: none;
        }
    }

    /* Narrow-width (RequestChanges sidebar ~320px): hide the elapsed chunk,
       shorten controls to icons-only. */
    @container ratings (max-width: 420px) {
        .count-elapsed {
            display: none;
        }
        .ctrl-label {
            display: none;
        }
    }
</style>
