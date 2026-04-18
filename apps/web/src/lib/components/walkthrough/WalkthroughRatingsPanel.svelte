<script lang="ts">
    import {
        CheckCircle2,
        AlertCircle,
        ShieldAlert,
        Gauge,
        X,
    } from "@lucide/svelte";
    import * as Dialog from "$lib/components/ui/dialog";
    import type {
        WalkthroughBlock,
        WalkthroughRating,
        Verdict,
        Confidence,
        RatingAxis,
    } from "@revv/shared";
    import { RATING_AXES, RATING_AXIS_LABELS } from "@revv/shared";
    import { jumpToDiffLine } from "$lib/stores/review.svelte";
    import FileBadge from "$lib/components/ui/FileBadge.svelte";
    import * as Tooltip from "$lib/components/ui/tooltip";
    import { renderMarkdown } from "$lib/utils/markdown";
    import { Skeleton } from "$lib/components/ui/skeleton/index.js";

    interface Props {
        ratings: WalkthroughRating[];
        blocks: WalkthroughBlock[];
        onJump: (blockId: string) => void;
    }

    let { ratings, blocks, onJump }: Props = $props();

    // Build a canonical 9-slot grid in stable axis order so the layout doesn't
    // shuffle as ratings stream in. Missing axes render as placeholder cards
    // (the AI hasn't rated them yet) rather than collapsing the grid.
    const gridCells = $derived(
        RATING_AXES.map((axis) => ({
            axis,
            rating: ratings.find((r) => r.axis === axis) ?? null,
        })),
    );

    // Hide the panel entirely until the first rating arrives — otherwise a
    // cached walkthrough generated before this feature existed would show
    // nine empty slots forever. Once any rating appears, we know the pipeline
    // is producing them and it's OK to show placeholders for stragglers.
    const hasAnyRating = $derived(ratings.length > 0);

    let selectedRating = $state<WalkthroughRating | null>(null);
    let selectedAxis = $state<RatingAxis | null>(null);

    let tooltipsEnabled = $state(false);

    // Re-derive whenever selectedRating changes (dialog opens/closes)
    $effect(() => {
        if (selectedRating) {
            tooltipsEnabled = false;
            const t = setTimeout(() => { tooltipsEnabled = true; }, 600);
            return () => clearTimeout(t);
        } else {
            tooltipsEnabled = false;
        }
    });

    const dialogOpen = $derived(selectedRating !== null);

    function openDialog(rating: WalkthroughRating, axis: RatingAxis): void {
        selectedRating = rating;
        selectedAxis = axis;
    }

    function closeDialog(): void {
        selectedRating = null;
        selectedAxis = null;
    }

    const verdictLabels: Record<Verdict, string> = {
        pass: "Pass",
        concern: "Concern",
        blocker: "Blocker",
    };

    const confidenceLabels: Record<Confidence, string> = {
        low: "LOW",
        medium: "MED",
        high: "HIGH",
    };

    function jumpToDiff(filePath: string, line: number): void {
        jumpToDiffLine(filePath, line);
    }

    const detailsHtml = $derived(
        selectedRating ? renderMarkdown(selectedRating.details) : null,
    );
</script>

{#if hasAnyRating}
    <section class="ratings-panel" aria-label="PR Scores">
        <div class="section-header">
            <Gauge size={18} />
            <h2 class="section-title">PR Scores</h2>
            <span class="section-header-hint">9 axes — AI rating</span>
        </div>

        <div class="ratings-grid">
            {#each gridCells as { axis, rating } (axis)}
                {#if rating}
                    {@const isPass = rating.verdict === "pass"}
                    {@const isConcern = rating.verdict === "concern"}
                    {@const isBlocker = rating.verdict === "blocker"}
                    <button
                        type="button"
                        class="rating-card rating-card--{rating.verdict}"
                        aria-label="{RATING_AXIS_LABELS[axis]}: {verdictLabels[rating.verdict]}"
                        onclick={() => openDialog(rating, axis)}
                    >
                        <div class="rating-card-top">
                            <span class="rating-axis"
                                >{RATING_AXIS_LABELS[axis]}</span
                            >
                            <span class="rating-confidence"
                                >{confidenceLabels[rating.confidence]}</span
                            >
                        </div>
                        <div class="rating-verdict-row">
                            <span class="rating-icon" aria-hidden="true">
                                {#if isPass}
                                    <CheckCircle2 size={14} />
                                {:else if isConcern}
                                    <AlertCircle size={14} />
                                {:else if isBlocker}
                                    <ShieldAlert size={14} />
                                {/if}
                            </span>
                            <span class="rating-verdict"
                                >{verdictLabels[rating.verdict]}</span
                            >
                        </div>
                    </button>
                {:else}
                    <div class="rating-card-skeleton" aria-hidden="true">
                        <div class="rating-card-top">
                            <Skeleton class="h-3 w-20 rounded" />
                            <Skeleton class="h-4 w-7 rounded-full" />
                        </div>
                        <div class="rating-verdict-row">
                            <Skeleton class="size-4 rounded-full" />
                            <Skeleton class="h-4 w-14 rounded" />
                        </div>
                    </div>
                {/if}
            {/each}
        </div>
    </section>
{/if}

<Dialog.Root
    open={dialogOpen}
    onOpenChange={(open) => {
        if (!open) closeDialog();
    }}
>
    <Dialog.Content class="dialog-ratings-content sm:max-w-xl">
        {#if selectedRating && selectedAxis}
            {@const isPass = selectedRating.verdict === "pass"}
            {@const isConcern = selectedRating.verdict === "concern"}
            {@const isBlocker = selectedRating.verdict === "blocker"}
            <div
                class="dialog-verdict-header dialog-verdict-header--{selectedRating.verdict}"
            >
                <div class="dialog-header-top dialog-header-top--{selectedRating.verdict}">
                    <span class="dialog-verdict-icon" aria-hidden="true">
                        {#if isPass}
                            <CheckCircle2 size={18} />
                        {:else if isConcern}
                            <AlertCircle size={18} />
                        {:else if isBlocker}
                            <ShieldAlert size={18} />
                        {/if}
                    </span>
                    <span class="dialog-axis-name"
                        >{RATING_AXIS_LABELS[selectedAxis]}</span
                    >
                </div>
                <span class="dialog-confidence-pill dialog-confidence-pill--{selectedRating.verdict}"
>{confidenceLabels[selectedRating.confidence]}</span>
            </div>
            <Dialog.Header class="sr-only">
                <Dialog.Title>{RATING_AXIS_LABELS[selectedAxis]}</Dialog.Title>
                <Dialog.Description
                    >{verdictLabels[selectedRating.verdict]}</Dialog.Description
                >
            </Dialog.Header>
            {#if detailsHtml}
                {#await detailsHtml then html}
                    <div class="dialog-details prose">{@html html}</div>
                {/await}
            {/if}
            {#if selectedRating.citations.length > 0}
                <p class="dialog-citations-header">References</p>
                <Tooltip.Provider delayDuration={300}>
                <ul class="dialog-citations">
                    {#each selectedRating.citations as citation, i (i)}
                        <li class="citation-item">
                            {#if citation.note}
                                <Tooltip.Root delayDuration={300} disabled={!tooltipsEnabled}>
                                    <Tooltip.Trigger>
                                        {#snippet child({ props })}
                                            <span class="citation-trigger" {...props}>
                                                <FileBadge
                                                    filePath={citation.filePath}
                                                    startLine={citation.startLine}
                                                    endLine={citation.endLine}
                                                    onclick={() => {
                                                        jumpToDiff(
                                                            citation.filePath,
                                                            citation.startLine,
                                                        );
                                                        closeDialog();
                                                    }}
                                                />
                                            </span>
                                        {/snippet}
                                    </Tooltip.Trigger>
                                    <Tooltip.Content side="right">{citation.note}</Tooltip.Content>
                                </Tooltip.Root>
                            {:else}
                                <FileBadge
                                    filePath={citation.filePath}
                                    startLine={citation.startLine}
                                    endLine={citation.endLine}
                                    onclick={() => {
                                        jumpToDiff(
                                            citation.filePath,
                                            citation.startLine,
                                        );
                                        closeDialog();
                                    }}
                                />
                            {/if}
                        </li>
                    {/each}
                </ul>
                </Tooltip.Provider>
            {/if}
        {/if}
    </Dialog.Content>
</Dialog.Root>

<style>
.ratings-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px 24px;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 10px;
}

    .section-header {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--color-text-muted);
    }

    .section-title {
        font-size: 18px;
        font-weight: 700;
        color: var(--color-text-primary);
        margin: 0;
    }

    .section-header-hint {
        font-size: 11px;
        font-weight: 400;
        opacity: 0.65;
    }

    .ratings-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
    }

    @media (max-width: 768px) {
        .ratings-grid {
            grid-template-columns: 1fr;
        }
    }

    .rating-card {
        display: flex;
        flex-direction: column;
        gap: 6px;
        border-radius: 8px;
        border-width: 1px;
        border-style: solid;
        border-color: var(--border, #e5e7eb);
        background: transparent;
        padding: 10px 12px;
        text-align: left;
        font: inherit;
        color: inherit;
        transition:
            border-color 140ms ease,
            background 140ms ease,
            transform 200ms ease-out,
            box-shadow 200ms ease-out;
        cursor: pointer;
    }

    .rating-card:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px
            color-mix(in srgb, var(--foreground, #000) 8%, transparent);
    }

    .rating-card--pass:hover {
        background: var(--color-score-pass-bg);
    }
    .rating-card--concern:hover {
        background: var(--color-score-concern-bg);
    }
    .rating-card--blocker:hover {
        background: var(--color-score-blocker-bg);
    }

    .rating-card-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .rating-axis {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted-foreground, #6b7280);
    }

    .rating-confidence {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.1em;
        color: var(--muted-foreground, #9ca3af);
        padding: 2px 6px;
        border-radius: 9999px;
        background: color-mix(
            in srgb,
            var(--muted-foreground, #9ca3af) 10%,
            transparent
        );
    }

    .rating-verdict-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .rating-icon {
        display: inline-flex;
        align-items: center;
    }

    .rating-verdict {
        font-size: 13px;
        font-weight: 600;
        line-height: 1;
    }

    /* ── Verdict color variants ────────────────────────────────────── */

    .rating-card--pass {
        background: transparent;
        border-width: 1px;
        border-style: solid;
        border-color: var(--color-score-pass-border);
        --c-icon: var(--color-score-pass-icon);
        --c-label: var(--color-score-pass-label);
        --c-axis: var(--color-score-pass-axis);
        --c-conf-bg: var(--color-score-pass-conf-bg);
        --c-conf: var(--color-score-pass-conf);
    }

    .rating-card--concern {
        background: transparent;
        border-width: 1px;
        border-style: solid;
        border-color: var(--color-score-concern-border);
        --c-icon: var(--color-score-concern-icon);
        --c-label: var(--color-score-concern-label);
        --c-axis: var(--color-score-concern-axis);
        --c-conf-bg: var(--color-score-concern-conf-bg);
        --c-conf: var(--color-score-concern-conf);
    }

    .rating-card--blocker {
        background: transparent;
        border-width: 1px;
        border-style: solid;
        border-color: var(--color-score-blocker-border);
        --c-icon: var(--color-score-blocker-icon);
        --c-label: var(--color-score-blocker-label);
        --c-axis: var(--color-score-blocker-axis);
        --c-conf-bg: var(--color-score-blocker-conf-bg);
        --c-conf: var(--color-score-blocker-conf);
    }

    .rating-card .rating-icon {
        color: var(--c-icon);
    }
    .rating-card .rating-verdict {
        color: var(--c-label);
    }
    .rating-card .rating-axis {
        color: var(--c-axis);
    }
    .rating-card .rating-confidence {
        color: var(--c-conf);
        background: var(--c-conf-bg);
    }

    /* ── Skeleton (not-yet-streamed) card ────────────────────────── */

    .rating-card-skeleton {
        display: flex;
        flex-direction: column;
        gap: 6px;
        border-radius: 8px;
        border: 1px solid var(--color-border, color-mix(in srgb, var(--border, #e5e7eb) 100%, transparent));
        padding: 10px 12px;
    }

    /* ── Dialog internals ─────────────────────────────────────────── */

    .dialog-verdict-header {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 20px 24px;
        padding-right: 3rem;
        border-radius: 8px 8px 0 0;
        margin: -24px -24px 0;
    }

    .dialog-header-top {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    /* Dialog header backgrounds — theme-aware via CSS vars */
    .dialog-verdict-header--pass {
        background: var(--color-score-pass-bg);
    }
    .dialog-verdict-header--concern {
        background: var(--color-score-concern-bg);
    }
    .dialog-verdict-header--blocker {
        background: var(--color-score-blocker-bg);
    }

    /* Dialog header-top icon+title color */
    .dialog-header-top--pass { color: var(--color-score-pass-icon); }
    .dialog-header-top--concern { color: var(--color-score-concern-icon); }
    .dialog-header-top--blocker { color: var(--color-score-blocker-icon); }

    /* Dialog confidence pill */
    .dialog-confidence-pill--pass {
        background: var(--color-score-pass-conf-bg);
        color: var(--color-score-pass-conf);
    }
    .dialog-confidence-pill--concern {
        background: var(--color-score-concern-conf-bg);
        color: var(--color-score-concern-conf);
    }
    .dialog-confidence-pill--blocker {
        background: var(--color-score-blocker-conf-bg);
        color: var(--color-score-blocker-conf);
    }

    .dialog-verdict-icon {
        display: inline-flex;
        align-items: center;
    }

    .dialog-axis-name {
        font-size: 18px;
        font-weight: 700;
        line-height: 1.2;
    }

    .dialog-confidence-pill {
        align-self: flex-start;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        padding: 2px 7px;
        border-radius: 9999px;
    }

    .dialog-details {
        margin-top: -8px;
        font-size: 13px;
        line-height: 1.6;
    }

    .dialog-details :global(p) { margin: 0 0 8px; color: var(--foreground); }
    .dialog-details :global(p:last-child) { margin-bottom: 0; }
    .dialog-details :global(strong) { font-weight: 600; color: var(--foreground); }
    .dialog-details :global(code) {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 0.85em;
        background: color-mix(in srgb, var(--muted-foreground) 12%, transparent);
        padding: 1px 4px;
        border-radius: 3px;
    }
    .dialog-details :global(ul), .dialog-details :global(ol) {
        margin: 4px 0 8px;
        padding-left: 1.25em;
    }
    .dialog-details :global(li) { margin-bottom: 3px; color: var(--foreground); }
    .dialog-details :global(h3) {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted-foreground);
        margin: 12px 0 4px;
    }

    .dialog-citations-header {
        font-size: 15px;
        font-weight: 500;
        color: var(--foreground);
        margin: 12px 0 6px;
        letter-spacing: 0;
        text-transform: none;
    }

    .dialog-citations {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: flex-start;
    }

    .citation-item {
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 3px;
        align-self: flex-start;
    }

    .citation-trigger {
        display: inline-flex;
    }
</style>
