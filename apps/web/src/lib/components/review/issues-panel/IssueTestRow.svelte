<script lang="ts">
    /*
     * IssueTestRow — one row in the Issues panel.
     *
     * Reads left-to-right like a lint diagnostic:
     *
     *   [✓]  E  async/unhandled-error  Unhandled async error in login  src/auth.ts:42-47  ›
     *   │    │  │                      │                                │
     *   │    │  │                      └ title (mono 13 / 600)          └ FileBadge trailing
     *   │    │  └ rule-slug chip (ESLint-ID style, lowercase mono)
     *   │    └ severity code letter (E/W/I — like TS2345 / clippy::lint / etc)
     *   └ selection checkbox (or green Check glyph when submitted)
     *
     * Wraps SpecRow; consumes it via snippets for icon/label/preview/trailing.
     * Selection checkbox must NOT bubble to the SpecRow trigger (otherwise
     * checking a box would also expand the row, which feels hostile).
     */
    import { Check, ArrowUpRight } from "@lucide/svelte";
    import type { WalkthroughIssue, WalkthroughBlock } from "@revv/shared";
    import FileBadge from "$lib/components/ui/FileBadge.svelte";
    import SpecRow, { type SpecRowState } from "../shared/SpecRow.svelte";
    import IssueExpandedBody from "./IssueExpandedBody.svelte";
    import { ruleSlugFor } from "./rule-slug";

    interface Props {
        issue: WalkthroughIssue;
        /** Is the checkbox ticked? Drives submit-review selection. */
        selected: boolean;
        /** Already posted to GitHub — row is dimmed, can't expand, checkbox
         *  replaced by a green Check glyph. */
        submitted: boolean;
        /** Controlled expanded state. */
        open: boolean;
        /** Index within the current filtered list — used for cascade-entry
         *  animation staggering. Capped at 6 in the parent so we don't
         *  wait forever on long lists. */
        index: number;
        /** Fired when the user ticks/unticks the checkbox. */
        onToggleSelect: () => void;
        /** Fired when the user clicks the row body (expand/collapse). */
        onToggleOpen: () => void;
        /** Jump to diff line when the FileBadge is clicked. */
        onFileClick?: ((filePath: string, line: number) => void) | undefined;
        /** Called on mount with the trigger element — the parent uses this
         *  to build a non-reactive map of refs for keyboard navigation.
         *  Also called with `null` on unmount so the map stays clean. */
        onTriggerRef?: ((el: HTMLElement | null) => void) | undefined;
        /** All walkthrough blocks — used to resolve blockIds to step numbers. */
        blocks: WalkthroughBlock[];
        /** Jump to a walkthrough block by id. Chips are only rendered when
         *  this callback is supplied AND the issue has blockIds. */
        onBlockJump?: ((blockId: string) => void) | undefined;
    }

    let {
        issue,
        selected,
        submitted,
        open,
        index,
        onToggleSelect,
        onToggleOpen,
        onFileClick,
        onTriggerRef,
        blocks,
        onBlockJump,
    }: Props = $props();

    // Forward the trigger ref from SpecRow up to the panel parent. Using a
    // local $state so the $effect below runs whenever SpecRow assigns it.
    let triggerRef = $state<HTMLElement | null>(null);

    $effect(() => {
        onTriggerRef?.(triggerRef);
        return () => onTriggerRef?.(null);
    });

    // Two-char severity code, like a compiler error prefix. Kept tabular
    // so rows line up vertically regardless of which severities are present.
    const severityCode: Record<WalkthroughIssue["severity"], string> = {
        critical: "E",
        warning: "W",
        info: "I",
    };

    const severityLabels: Record<WalkthroughIssue["severity"], string> = {
        critical: "Critical",
        warning: "Warning",
        info: "Info",
    };

    // Rule-slug — deterministic, client-side derived from the title. Purely
    // cosmetic (nothing behaves on it); if the helper returns null we
    // silently drop the chip and fall back to the severity word.
    const ruleSlug = $derived(ruleSlugFor(issue));

    const ariaLabel = $derived(
        `${severityLabels[issue.severity]}: ${issue.title}` +
            (submitted ? " (posted)" : ""),
    );

    // Cascade-entry delay. Cap at 6 so long lists resolve quickly.
    const delay = $derived(`${Math.min(index, 6) * 50}ms`);

    // SpecRow lifecycle: submitted rows render as "submitted" (dimmed, no
    // expand); everything else is "resolved" (the normal steady state).
    // Deliberately named `rowState` — avoid `state` which collides with
    // the Svelte $state rune name in svelte-check's flow analysis.
    const rowState: SpecRowState = $derived(submitted ? "submitted" : "resolved");

    // Resolve blockIds to step numbers using the blocks array.
    const resolvedBlockLinks = $derived.by(() => {
        const out: { blockId: string; stepN: number }[] = [];
        for (const blockId of issue.blockIds) {
            const idx = blocks.findIndex((b) => b.id === blockId);
            if (idx >= 0) out.push({ blockId, stepN: idx + 1 });
        }
        return out;
    });

    function handleCheckboxChange(e: Event): void {
        e.stopPropagation();
        if (submitted) return;
        onToggleSelect();
    }

    function handleCheckboxClick(e: MouseEvent): void {
        // Stop the click bubbling up to the SpecRow trigger — otherwise
        // toggling selection would also expand/collapse the row.
        e.stopPropagation();
    }
</script>

<div
    class="issue-row issue-row--{issue.severity}"
    class:issue-row--submitted={submitted}
    class:issue-row--selected={selected}
    style:--issue-delay={delay}
    data-open={open ? "true" : undefined}
>
    <SpecRow
        {open}
        onToggle={onToggleOpen}
        state={rowState}
        disabled={submitted}
        {ariaLabel}
        dataKind="issue"
        bind:triggerRef
    >
        {#snippet icon()}
            {#if submitted}
                <span class="staged-check" aria-hidden="true">
                    <Check size={13} />
                </span>
            {:else}
                <input
                    type="checkbox"
                    class="issue-checkbox"
                    checked={selected}
                    aria-label="Include in submit"
                    onchange={handleCheckboxChange}
                    onclick={handleCheckboxClick}
                />
            {/if}
        {/snippet}

        {#snippet label()}
            <span
                class="severity-code severity-code--{issue.severity}"
                title={severityLabels[issue.severity]}
            >
                {severityCode[issue.severity]}
            </span>
            <span class="issue-title">{issue.title}</span>
        {/snippet}

        {#snippet preview()}
            <span class="issue-preview">{issue.description}</span>
        {/snippet}

        {#snippet trailing()}
            <span class="trailing-steps">
                {#if resolvedBlockLinks.length > 0 && onBlockJump}
                    {#each resolvedBlockLinks as { blockId, stepN } (blockId)}
                        <button
                            type="button"
                            class="step-chip"
                            onclick={(e) => { e.stopPropagation(); onBlockJump(blockId); }}
                        >
                            <ArrowUpRight size={10} aria-hidden="true" />
                            step {stepN}
                        </button>
                    {/each}
                {/if}
            </span>
            <span class="trailing-file">
                {#if issue.filePath}
                    <span
                        class="file-badge-slot"
                        onclick={(e) => e.stopPropagation()}
                        role="presentation"
                    >
                        <FileBadge
                            filePath={issue.filePath}
                            startLine={issue.startLine}
                            endLine={issue.endLine}
                            onclick={onFileClick
                                ? () => onFileClick(issue.filePath!, issue.startLine ?? 1)
                                : undefined}
                        />
                    </span>
                {/if}
            </span>
        {/snippet}

        {#snippet content()}
            <IssueExpandedBody {issue} />
        {/snippet}
    </SpecRow>
</div>

<style>
    .issue-row {
        /* SpecRow reads these custom props to paint its gutter and hover. */
        --c-gutter-color: var(--color-border);
        --c-row-bg: var(--color-bg-elevated);
        --c-gutter-flash: var(--c-gutter-color);
        animation: issue-row-enter 0.5s var(--ease-out-expo) both;
        animation-delay: var(--issue-delay, 0ms);
    }

    /* Severity → palette mapping. Uses the existing `--color-score-*`
       tokens so issue gutters match scorecard gutters 1:1 for concern /
       blocker, plus the new `--color-score-info-*` family for info. */
    .issue-row--critical {
        --c-gutter-color: var(--color-score-blocker-icon);
        --c-row-bg: var(--color-score-blocker-bg);
        --c-gutter-flash: color-mix(in srgb, var(--color-score-blocker-icon) 70%, white);
    }
    .issue-row--warning {
        --c-gutter-color: var(--color-score-concern-icon);
        --c-row-bg: var(--color-score-concern-bg);
        --c-gutter-flash: color-mix(in srgb, var(--color-score-concern-icon) 70%, white);
    }
    .issue-row--info {
        --c-gutter-color: var(--color-score-info-icon);
        --c-row-bg: var(--color-score-info-bg);
        --c-gutter-flash: color-mix(in srgb, var(--color-score-info-icon) 70%, white);
    }

    /* Subtle background tint when a row is selected but not yet submitted —
       signals "in the next submit batch" without shouting. */
    .issue-row--selected:not(.issue-row--submitted) {
        background: color-mix(in srgb, var(--c-gutter-color) 6%, transparent);
    }

    /* Expanded-state background tint — mirrors RatingTestRow's open state. */
    .issue-row[data-open="true"] :global(.spec-row-trigger:not(:disabled):not([aria-disabled="true"])) {
        background: color-mix(
            in srgb,
            var(--c-gutter-color) 8%,
            transparent
        );
    }

    /* ── Checkbox / staged-check ──────────────────────────────── */

    .issue-checkbox {
        width: 13px;
        height: 13px;
        margin: 0;
        accent-color: var(--color-accent);
        cursor: pointer;
    }

    .staged-check {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--color-success);
    }

    /* ── Severity code letter (E / W / I) ────────────────────── */

    .severity-code {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 1px 5px;
        border-radius: 3px;
        min-width: 2ch;
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }

    .severity-code--critical {
        color: var(--color-score-blocker-label);
        background: color-mix(in srgb, var(--color-score-blocker-bg) 85%, transparent);
        border: 1px solid color-mix(in srgb, var(--color-score-blocker-border) 35%, transparent);
    }
    .severity-code--warning {
        color: var(--color-score-concern-label);
        background: color-mix(in srgb, var(--color-score-concern-bg) 85%, transparent);
        border: 1px solid color-mix(in srgb, var(--color-score-concern-border) 35%, transparent);
    }
    .severity-code--info {
        color: var(--color-score-info-label);
        background: color-mix(in srgb, var(--color-score-info-bg) 85%, transparent);
        border: 1px solid color-mix(in srgb, var(--color-score-info-border) 35%, transparent);
    }

    /* ── Issue title — the headline, sans-serif for readability ─ */

    .issue-title {
        font-family: var(--font-sans);
        font-size: 13px;
        font-weight: 500;
        color: var(--color-text-secondary);
        letter-spacing: -0.005em;
        line-height: 1.3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }

    .issue-preview {
        font-family: var(--font-sans);
        font-size: 12px;
        color: var(--color-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }

    /* ── FileBadge slot — stop propagation on clicks so the badge
       jumps to the diff without toggling the row. ─────────────── */

    .file-badge-slot {
        display: inline-flex;
        align-items: center;
    }

    /* ── Trailing column slots — fixed widths give cross-row alignment ── */

    .trailing-steps {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        width: 76px;
        flex-shrink: 0;
    }

    .trailing-file {
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        width: 96px;
        flex-shrink: 0;
    }

    /* ── Step chips — navigate to walkthrough block ──────────── */

    .step-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 7px;
        border-radius: 9999px;
        border: 1px solid var(--color-border);
        background: transparent;
        color: var(--color-text-muted);
        font-family: var(--font-mono);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: lowercase;
        cursor: pointer;
        flex-shrink: 0;
        transition:
            border-color var(--duration-snap) var(--ease-soft),
            color var(--duration-snap) var(--ease-soft),
            background var(--duration-snap) var(--ease-soft);
    }
.step-chip:hover {
    border-color: color-mix(in srgb, var(--c-gutter-color) 55%, transparent);
    color: color-mix(in srgb, var(--c-gutter-color) 75%, var(--color-text-muted));
    background: color-mix(in srgb, var(--c-gutter-color) 8%, transparent);
}
    .step-chip:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
    }

    /* ── When row is open, step chips adopt the severity colour ──── */

    .issue-row[data-open="true"] .step-chip {
        border-color: color-mix(in srgb, var(--c-gutter-color) 45%, transparent);
        color: var(--c-gutter-color);
        background: color-mix(in srgb, var(--c-gutter-color) 8%, transparent);
    }

    .issue-row[data-open="true"] .step-chip:hover {
        border-color: var(--c-gutter-color);
        background: color-mix(in srgb, var(--c-gutter-color) 15%, transparent);
    }

    /* ── Entry animation ─────────────────────────────────────── */

    @keyframes issue-row-enter {
        from {
            opacity: 0;
            transform: translateY(4px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .issue-row {
            animation: none;
        }
    }
</style>
