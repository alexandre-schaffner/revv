<script lang="ts">
import ArrowsInLineVertical from "phosphor-svelte/lib/ArrowsInLineVertical";
import ArrowsOutLineVertical from "phosphor-svelte/lib/ArrowsOutLineVertical";
import Funnel from "phosphor-svelte/lib/Funnel";
import type { Component, Snippet } from "svelte";

interface Filter {
  label: string;
  active: boolean;
  onToggle: () => void;
  /** Pressed colour. `concern` for a filter that narrows to failures. */
  tone?: "accent" | "concern";
}

interface Props {
  title: string;
  icon: Snippet;
  /** `SpecCount` pills, plus anything else that belongs on the count line. */
  counts: Snippet;
  /** Omit for a panel whose rows can't all be open at once. */
  expand?: { all: boolean | null; onToggle: () => void } | undefined;
  filters: Filter[];
  action?: { label: string; icon: Component<{ size?: number }>; onclick: () => void } | undefined;
}

let { title, icon, counts, expand, filters, action }: Props = $props();

const expandLabel = $derived(expand?.all === true ? "Collapse all" : "Expand all");
</script>

<div class="summary-bar">
    <div class="summary-left">
        <span class="spec-icon" aria-hidden="true">{@render icon()}</span>
        <span class="spec-title">{title}</span>

        <div class="count-pills" role="status" aria-live="polite">
            {@render counts()}
        </div>
    </div>

    <div class="summary-controls">
        {#if expand}
            <button
                type="button"
                class="ctrl-btn"
                onclick={expand.onToggle}
                aria-pressed={expand.all === true}
                title={expandLabel}
            >
                <span class="ctrl-icon" aria-hidden="true">
                    {#if expand.all === true}
                        <ArrowsInLineVertical size={12} />
                    {:else}
                        <ArrowsOutLineVertical size={12} />
                    {/if}
                </span>
                <span class="ctrl-label">{expandLabel}</span>
            </button>
        {/if}
        {#each filters as filter (filter.label)}
            <button
                type="button"
                class="ctrl-btn"
                class:ctrl-btn--pressed={filter.active}
                class:ctrl-btn--concern={filter.tone === "concern"}
                onclick={filter.onToggle}
                aria-pressed={filter.active}
                title={filter.label}
            >
                <span class="ctrl-icon" aria-hidden="true">
                    <Funnel size={12} weight={filter.active ? "fill" : "regular"} />
                </span>
                <span class="ctrl-label">{filter.label}</span>
            </button>
        {/each}
        {#if action}
            <button type="button" class="ctrl-btn" onclick={action.onclick} title={action.label}>
                <span class="ctrl-icon" aria-hidden="true">
                    <action.icon size={12} />
                </span>
                <span class="ctrl-label">{action.label}</span>
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

    .count-pills {
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: var(--font-mono);
        font-size: 11.5px;
        flex-wrap: wrap;
    }

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

    /* `:where` keeps these at the specificity of the accent rules they replace,
       so `.ctrl-btn:hover` still wins the text colour. */
    .ctrl-btn--concern:where(.ctrl-btn--pressed) {
        background: var(--color-score-concern-bg);
        color: var(--color-score-concern-label);
        border-color: color-mix(in srgb, var(--color-score-concern-border) 40%, transparent);
    }

    .ctrl-btn--concern:where(.ctrl-btn--pressed):hover {
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

    @container spec-panel (max-width: 420px) {
        .ctrl-label {
            display: none;
        }
    }
</style>
