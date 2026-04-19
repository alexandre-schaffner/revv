<script lang="ts">
    /*
     * CommentSummaryBar — header of the comments panel. Styled as a
     * `git log` / `gh pr view` banner:
     *
     *   💬 Comments   ● 3 unresolved  ● 2 with replies  │  4 selected
     *
     *   [Expand all] [Only with replies] [Only unselected] [Select all / Clear]
     */
    import {
        MessageSquare,
        Circle,
        ChevronsDownUp,
        ChevronsUpDown,
        Filter,
    } from "@lucide/svelte";

    interface Counts {
        unresolved: number;
        withReplies: number;
    }

    interface Props {
        counts: Counts;
        expandAll: boolean | null;
        onlyWithReplies: boolean;
        onToggleExpandAll: () => void;
        onToggleOnlyWithReplies: () => void;
    }

    let {
        counts,
        expandAll,
        onlyWithReplies,
        onToggleExpandAll,
        onToggleOnlyWithReplies,
    }: Props = $props();

    const expandLabel = $derived(
        expandAll === true ? "Collapse all" : "Expand all",
    );
</script>

<div class="summary-bar">
    <div class="summary-left">
        <span class="spec-icon" aria-hidden="true">
            <MessageSquare size={14} />
        </span>
        <span class="spec-title">Comments</span>

        <div class="count-pills" role="status" aria-live="polite">
            <span
                class="count-pill count-pill--unresolved"
                class:count-pill--zero={counts.unresolved === 0}
                title="{counts.unresolved} unresolved"
            >
                <Circle size={11} aria-hidden="true" />
                <span class="count-num">{counts.unresolved}</span>
                <span class="count-label">unresolved</span>
            </span>
            <span
                class="count-pill count-pill--replies"
                class:count-pill--zero={counts.withReplies === 0}
                title="{counts.withReplies} with replies"
            >
                <Circle size={11} aria-hidden="true" />
                <span class="count-num">{counts.withReplies}</span>
                <span class="count-label">with replies</span>
            </span>
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
            class:ctrl-btn--pressed={onlyWithReplies}
            onclick={onToggleOnlyWithReplies}
            aria-pressed={onlyWithReplies}
            title="Only with replies"
        >
            <span class="ctrl-icon" aria-hidden="true">
                <Filter size={12} />
            </span>
            <span class="ctrl-label">Only with replies</span>
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

    .count-pill--unresolved {
        color: var(--color-accent);
        background: color-mix(in srgb, var(--color-accent) 12%, transparent);
    }

    .count-pill--replies {
        color: var(--color-text-muted);
        background: color-mix(
            in srgb,
            var(--color-text-muted) 10%,
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

    /* ── Toolbar controls ───────────────────────────────────── */

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

    /* ── Narrow-width ───────────────────────────────────────── */

    @container comments (max-width: 420px) {
        .count-label {
            display: none;
        }
        .ctrl-label {
            display: none;
        }
    }
</style>
