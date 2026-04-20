<script lang="ts">
    /*
     * SpecRow — local copy-adapt of ratings-panel/RatingTestRow's row primitive.
     *
     * The scorecard's RatingTestRow is intentionally hard-coded to its verdict
     * palette and its trigger layout. Rather than refactor that polished file
     * (the plan forbids touching it), we replicate the *mechanical* parts —
     * gutter, grid trigger, Collapsible wiring, lifecycle keyframes — as a
     * generic row usable by both the issues and comments panels.
     *
     * Callers drive appearance via CSS custom properties set on their own
     * wrapper (e.g. `--c-gutter-color`, `--c-row-bg`). Slots are exposed as
     * snippets so a caller can choose between a checkbox, an icon, or nothing
     * for each column.
     *
     * Columns (grid-template):
     *   icon (2ch) · label+preview (1fr) · trailing (auto) · chevron (16px)
     *
     * The row is always collapsible (unless `disabled`). There's no "no
     * collapse" variant — panels that want click-to-jump use the scorecard's
     * own RatingTestRow directly, not this primitive.
     */
    import { ChevronRight } from "@lucide/svelte";
    import * as Collapsible from "$lib/components/ui/collapsible";
    import type { Snippet } from "svelte";

    export type SpecRowState = "queued" | "running" | "resolved" | "submitted";

    interface Props {
        /** Controlled open state. */
        open: boolean;
        /** Fires when the user clicks the trigger (ignored while disabled). */
        onToggle: () => void;
        /** Lifecycle state — drives gutter animation + opacity. */
        state?: SpecRowState;
        /** When true, the row cannot be expanded (trigger is inert). Use for
         *  submitted or read-only rows. */
        disabled?: boolean;
        /** Screen-reader label for the trigger. */
        ariaLabel?: string;
        /** Binds the trigger element upward so a parent can manage focus /
         *  keyboard navigation across rows. */
        triggerRef?: HTMLElement | null;
        /** Optional data attribute — useful for panel-level CSS hooks. */
        dataKind?: string;
        /** Slots — each returns the content for one column of the trigger
         *  grid. All are optional; a missing slot renders an empty cell. */
        icon?: Snippet;
        label?: Snippet;
        preview?: Snippet;
        trailing?: Snippet;
        /** Expanded body, rendered inside Collapsible.Content. */
        content?: Snippet;
    }

    let {
        open,
        onToggle,
        state = "resolved",
        disabled = false,
        ariaLabel,
        triggerRef = $bindable(null),
        dataKind,
        icon,
        label,
        preview,
        trailing,
        content,
    }: Props = $props();
</script>

<li
    class="spec-row"
    data-state={state}
    data-kind={dataKind}
    aria-busy={state === "running" ? "true" : undefined}
>
    <Collapsible.Root
        {open}
        onOpenChange={(next: boolean) => {
            if (disabled) return;
            if (next !== open) onToggle();
        }}
    >
        <Collapsible.Trigger
            class="spec-row-trigger"
            disabled={disabled}
            aria-disabled={disabled}
            aria-label={ariaLabel}
            bind:ref={triggerRef}
        >
            <span class="spec-row-gutter" aria-hidden="true"></span>

            <span class="spec-row-icon">
                {#if icon}{@render icon()}{/if}
            </span>

            <span class="spec-row-label">
                {#if label}{@render label()}{/if}
                {#if !open && preview}
                    <span class="spec-row-preview">{@render preview()}</span>
                {/if}
            </span>

            <span class="spec-row-trailing">
                {#if trailing}{@render trailing()}{/if}
            </span>

            <span
                class="spec-row-chevron"
                class:spec-row-chevron--open={open}
                class:spec-row-chevron--hidden={disabled}
                aria-hidden="true"
            >
                <ChevronRight size={14} />
            </span>
        </Collapsible.Trigger>

        {#if content}
            <Collapsible.Content>
                {@render content()}
            </Collapsible.Content>
        {/if}
    </Collapsible.Root>
</li>

<style>
    .spec-row {
        list-style: none;
        position: relative;
        display: block;
    }

    /* ── Row trigger (clickable header) ─────────────────────────── */

    :global(.spec-row-trigger) {
        display: grid;
        /* icon · label+preview · trailing · chevron */
        grid-template-columns:
            2ch
            minmax(0, 1fr)
            auto
            16px;
        align-items: center;
        gap: 8px;
        width: 100%;
        overflow: hidden;
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

    :global(.spec-row-trigger:disabled),
    :global(.spec-row-trigger[aria-disabled="true"]) {
        cursor: default;
    }

    :global(.spec-row-trigger:focus-visible) {
        outline: 2px solid var(--color-accent);
        outline-offset: -2px;
    }

    :global(.spec-row-trigger:hover:not(:disabled):not([aria-disabled="true"])) {
        background: color-mix(
            in srgb,
            var(--c-row-bg, var(--color-bg-elevated)) 50%,
            transparent
        );
    }

    /* ── Left gutter ────────────────────────────────────────────── */

    .spec-row-gutter {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: var(--gutter-w, 2px);
        background: var(--c-gutter-color, var(--color-border));
        transition: background var(--duration-quick) var(--ease-soft);
    }

    .spec-row[data-state="queued"] .spec-row-gutter {
        background: var(--color-border);
    }

    .spec-row[data-state="running"] .spec-row-gutter {
        animation: spec-row-pulse-gutter 1.2s ease-in-out infinite;
    }

    .spec-row[data-state="resolved"] .spec-row-gutter {
        animation: spec-row-gutter-flash 320ms var(--ease-out-expo) 1;
    }

    .spec-row[data-state="submitted"] .spec-row-gutter {
        background: var(--c-gutter-color-submitted, var(--color-success));
    }

    @keyframes spec-row-pulse-gutter {
        0%,
        100% {
            background: var(--color-border);
        }
        50% {
            background: var(--color-accent);
        }
    }

    @keyframes spec-row-gutter-flash {
        0% {
            background: var(--c-gutter-flash, var(--c-gutter-color));
            box-shadow: 0 0 6px
                color-mix(in srgb, var(--c-gutter-color, var(--color-text-primary)) 50%, transparent);
        }
        100% {
            background: var(--c-gutter-color, var(--color-border));
            box-shadow: none;
        }
    }

    /* ── Column slots ──────────────────────────────────────────── */

    .spec-row-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--c-icon-color, var(--color-text-muted));
    }

    .spec-row-label {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-family: var(--font-mono);
        font-size: 13px;
        font-weight: 600;
        color: var(--c-label-color, var(--color-text-primary));
        white-space: nowrap;
        letter-spacing: 0.01em;
        min-width: 0;
        overflow: hidden;
    }

    .spec-row-preview {
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
        flex: 1 1 0;
        font-weight: 400;
        letter-spacing: 0;
    }

    .spec-row-trailing {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
        min-width: 0;
    }

    /* ── Chevron ────────────────────────────────────────────────── */

    .spec-row-chevron {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--color-text-muted);
        transition: transform var(--duration-snap) var(--ease-out-expo);
    }

    .spec-row-chevron--open {
        transform: rotate(90deg);
    }

    .spec-row-chevron--hidden {
        visibility: hidden;
    }

    /* ── Row lifecycle opacity ──────────────────────────────────── */

    .spec-row[data-state="queued"] :global(.spec-row-trigger) {
        opacity: 0.45;
    }

    .spec-row[data-state="running"] :global(.spec-row-trigger) {
        opacity: 0.75;
    }

    .spec-row[data-state="resolved"] :global(.spec-row-trigger) {
        animation: spec-row-resolve 180ms var(--ease-out-expo) 1;
    }

    .spec-row[data-state="submitted"] :global(.spec-row-trigger) {
        opacity: 0.55;
    }

    @keyframes spec-row-resolve {
        0% {
            transform: translateX(-2px);
            opacity: 0.7;
        }
        100% {
            transform: translateX(0);
            opacity: 1;
        }
    }

    /* ── Reduced motion ─────────────────────────────────────────── */

    @media (prefers-reduced-motion: reduce) {
        .spec-row[data-state="running"] .spec-row-gutter,
        .spec-row[data-state="resolved"] .spec-row-gutter {
            animation: none;
        }
        .spec-row[data-state="resolved"] :global(.spec-row-trigger) {
            animation: none;
        }
        .spec-row-chevron {
            transition: none;
        }
    }
</style>
