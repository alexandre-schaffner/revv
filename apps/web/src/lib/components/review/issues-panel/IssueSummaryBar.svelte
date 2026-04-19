<script lang="ts">
    /*
     * IssueSummaryBar — the header of the Issues panel. Styled as a linter
     * summary line:
     *
     *   ⚠ walkthrough    ✕ 3 critical  ▲ 5 warnings  • 2 info  │  4 selected
     *                                                          ^
     *                                                          divider bar
     *
     *   [Expand all] [Only critical] [Only unselected] [Select all / Clear]
     *
     * Count-pills mirror the verdict-pill treatment from
     * RatingSummaryBar.svelte but keyed to severity (critical / warning /
     * info) and a selection pill on the right. The divider character
     * (a literal `│`) signals the transition from "counts" to "selection".
     */
    import {
        AlertTriangle,
        X as XIcon,
        Triangle,
        Circle,
        ChevronsDownUp,
        ChevronsUpDown,
        Filter,
        CheckSquare,
        Square,
    } from "@lucide/svelte";

    interface Counts {
        critical: number;
        warning: number;
        info: number;
        total: number;
        selected: number;
        submittable: number;
    }

    interface Props {
        counts: Counts;
        expandAll: boolean | null;
        onlyCritical: boolean;
        onlyUnselected: boolean;
        allSelected: boolean;
        onToggleExpandAll: () => void;
        onToggleOnlyCritical: () => void;
        onToggleOnlyUnselected: () => void;
        onToggleSelectAll: () => void;
    }

    let {
        counts,
        expandAll,
        onlyCritical,
        onlyUnselected,
        allSelected,
        onToggleExpandAll,
        onToggleOnlyCritical,
        onToggleOnlyUnselected,
        onToggleSelectAll,
    }: Props = $props();

    const expandLabel = $derived(expandAll === true ? "Collapse all" : "Expand all");
    const selectLabel = $derived(allSelected ? "Clear" : "Select all");
</script>

<div class="summary-bar">
    <div class="summary-left">
        <span class="spec-icon" aria-hidden="true">
            <AlertTriangle size={14} />
        </span>
        <span class="spec-title">Issues</span>

        <div class="count-pills" role="status" aria-live="polite">
            <span
                class="count-pill count-pill--critical"
                class:count-pill--zero={counts.critical === 0}
                title="{counts.critical} critical"
            >
                <XIcon size={11} aria-hidden="true" />
                <span class="count-num">{counts.critical}</span>
                <span class="count-label">critical</span>
            </span>
            <span
                class="count-pill count-pill--warning"
                class:count-pill--zero={counts.warning === 0}
                title="{counts.warning} warning{counts.warning === 1 ? '' : 's'}"
            >
                <Triangle size={11} aria-hidden="true" />
                <span class="count-num">{counts.warning}</span>
                <span class="count-label"
                    >{counts.warning === 1 ? "warning" : "warnings"}</span
                >
            </span>
            <span
                class="count-pill count-pill--info"
                class:count-pill--zero={counts.info === 0}
                title="{counts.info} info"
            >
                <Circle size={11} aria-hidden="true" />
                <span class="count-num">{counts.info}</span>
                <span class="count-label">info</span>
            </span>

            {#if counts.submittable > 0}
                <span class="count-divider" aria-hidden="true">│</span>
                <span
                    class="count-pill count-pill--selected"
                    class:count-pill--zero={counts.selected === 0}
                    title="{counts.selected} selected for submit"
                >
                    <span class="count-num">{counts.selected}</span>
                    <span class="count-label">selected</span>
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
            title={expandLabel}
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
            class:ctrl-btn--pressed={onlyCritical}
            onclick={onToggleOnlyCritical}
            aria-pressed={onlyCritical}
            title="Only critical"
        >
            <span class="ctrl-icon" aria-hidden="true">
                <Filter size={12} />
            </span>
            <span class="ctrl-label">Only critical</span>
        </button>
        <button
            type="button"
            class="ctrl-btn"
            class:ctrl-btn--pressed={onlyUnselected}
            onclick={onToggleOnlyUnselected}
            aria-pressed={onlyUnselected}
            title="Only unselected"
        >
            <span class="ctrl-icon" aria-hidden="true">
                <Filter size={12} />
            </span>
            <span class="ctrl-label">Only unselected</span>
        </button>
        {#if counts.submittable > 0}
            <button
                type="button"
                class="ctrl-btn"
                onclick={onToggleSelectAll}
                title={selectLabel}
            >
                <span class="ctrl-icon" aria-hidden="true">
                    {#if allSelected}
                        <Square size={12} />
                    {:else}
                        <CheckSquare size={12} />
                    {/if}
                </span>
                <span class="ctrl-label">{selectLabel}</span>
            </button>
        {/if}
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

    /* ── Count pills ────────────────────────────────────────── */

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

    .count-pill--critical {
        color: var(--color-score-blocker-label);
        background: color-mix(in srgb, var(--color-score-blocker-bg) 60%, transparent);
    }

    .count-pill--warning {
        color: var(--color-score-concern-label);
        background: color-mix(in srgb, var(--color-score-concern-bg) 60%, transparent);
    }

    .count-pill--info {
        color: var(--color-score-info-label);
        background: color-mix(in srgb, var(--color-score-info-bg) 60%, transparent);
    }

    .count-pill--selected {
        color: var(--color-accent);
        background: color-mix(in srgb, var(--color-accent) 12%, transparent);
    }

    .count-num {
        font-weight: 700;
    }

    .count-label {
        font-weight: 500;
        letter-spacing: 0.01em;
    }

    .count-divider {
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-muted);
        opacity: 0.4;
    }

    /* ── Toolbar controls — same treatment as RatingSummaryBar ─ */

    .summary-controls {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
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
        background: color-mix(in srgb, var(--color-text-primary) 8%, transparent);
        color: var(--color-text-primary);
    }

    .ctrl-btn:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
    }

    .ctrl-btn--pressed {
        background: color-mix(in srgb, var(--color-accent) 12%, transparent);
        color: var(--color-accent);
        border-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
    }

    .ctrl-btn--pressed:hover {
        background: color-mix(in srgb, var(--color-accent) 18%, transparent);
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

    /* ── Narrow-width (RequestChanges sidebar ~320px) ────────── */

    @container issues (max-width: 420px) {
        .count-label {
            display: none;
        }
        .ctrl-label {
            display: none;
        }
    }
</style>
