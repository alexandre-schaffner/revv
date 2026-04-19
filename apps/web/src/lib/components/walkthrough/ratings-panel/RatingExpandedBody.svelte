<script lang="ts">
    import { ArrowUpRight } from "@lucide/svelte";
    import type {
        WalkthroughRating,
        WalkthroughBlock,
        Verdict,
        Confidence,
    } from "@revv/shared";
    import FileBadge from "$lib/components/ui/FileBadge.svelte";
    import * as Tooltip from "$lib/components/ui/tooltip";
    import { jumpToDiffLine } from "$lib/stores/review.svelte";
    import { renderMarkdown } from "$lib/utils/markdown";

    interface Props {
        rating: WalkthroughRating;
        /** Full ordered block list — used to resolve blockIds to step numbers. */
        blocks: WalkthroughBlock[];
        onJump: (blockId: string) => void;
    }

    let { rating, blocks, onJump }: Props = $props();

    // Resolve each blockId to its GLOBAL position in the walkthrough. Filter
    // out ids that don't resolve — those would make the chip broken (no jump
    // target exists). Matches the pattern in GuidedWalkthrough's IssueCard
    // stepTag logic, which gates clickability on `stepNumberFor` != null.
    const resolvedBlockLinks = $derived.by(() => {
        const out: { blockId: string; stepN: number }[] = [];
        for (const blockId of rating.blockIds) {
            const idx = blocks.findIndex((b) => b.id === blockId);
            if (idx >= 0) out.push({ blockId, stepN: idx + 1 });
        }
        return out;
    });

    // Details markdown is rendered async through marked + highlighter; gate with
    // {#await} in the template so we never flash raw markdown at the user.
    const detailsHtml = $derived(
        rating.details && rating.details.trim().length > 0
            ? renderMarkdown(rating.details)
            : null,
    );

    // Tooltips are only enabled after a short delay after expansion, matching
    // the original Dialog pattern (lines 201–226). Without this gate, a tooltip
    // on the citation trigger pops up instantly whenever the panel expands,
    // which feels noisy.
    let tooltipsEnabled = $state(false);
    $effect(() => {
        tooltipsEnabled = false;
        const t = setTimeout(() => {
            tooltipsEnabled = true;
        }, 600);
        return () => clearTimeout(t);
    });

    const verdictLabels: Record<Verdict, string> = {
        pass: "pass",
        concern: "concern",
        blocker: "blocker",
    };

    const confidenceLabels: Record<Confidence, string> = {
        low: "low confidence",
        medium: "medium confidence",
        high: "high confidence",
    };

    function handleJumpToDiff(filePath: string, line: number): void {
        jumpToDiffLine(filePath, line);
    }
</script>

<div class="expanded-body" data-verdict={rating.verdict}>
    <div class="rationale">
        <p class="rationale-text">{rating.rationale}</p>
    </div>

    {#if rating.verdict !== "pass"}
        <div class="expected-received">
            <div class="er-row">
                <span class="er-label">Expected:</span>
                <span class="er-value er-value--pass">pass</span>
            </div>
            <div class="er-row">
                <span class="er-label">Received:</span>
                <span class="er-value er-value--{rating.verdict}"
                    >{verdictLabels[rating.verdict]}</span
                >
                <span class="er-confidence"
                    >{confidenceLabels[rating.confidence]}</span
                >
            </div>
        </div>
    {/if}

    {#if detailsHtml}
        <div class="section-divider" aria-hidden="true">
            <span class="section-divider-label">details</span>
        </div>
        {#await detailsHtml then html}
            <div class="rating-details prose">{@html html}</div>
        {/await}
    {/if}

    {#if rating.citations.length > 0}
        <div class="section-divider" aria-hidden="true">
            <span class="section-divider-label">references</span>
        </div>
        <Tooltip.Provider delayDuration={300}>
            <ul class="references">
                {#each rating.citations as citation, i (i)}
                    <li class="reference-item">
                        {#if citation.note}
                            <Tooltip.Root
                                delayDuration={300}
                                disabled={!tooltipsEnabled}
                            >
                                <Tooltip.Trigger>
                                    {#snippet child({ props })}
                                        <span class="reference-trigger" {...props}>
                                            <FileBadge
                                                filePath={citation.filePath}
                                                startLine={citation.startLine}
                                                endLine={citation.endLine}
                                                onclick={() =>
                                                    handleJumpToDiff(
                                                        citation.filePath,
                                                        citation.startLine,
                                                    )}
                                            />
                                        </span>
                                    {/snippet}
                                </Tooltip.Trigger>
                                <Tooltip.Content side="right"
                                    >{citation.note}</Tooltip.Content
                                >
                            </Tooltip.Root>
                        {:else}
                            <FileBadge
                                filePath={citation.filePath}
                                startLine={citation.startLine}
                                endLine={citation.endLine}
                                onclick={() =>
                                    handleJumpToDiff(
                                        citation.filePath,
                                        citation.startLine,
                                    )}
                            />
                        {/if}
                    </li>
                {/each}
            </ul>
        </Tooltip.Provider>
    {/if}

    {#if resolvedBlockLinks.length > 0}
        <ul class="block-links">
            {#each resolvedBlockLinks as { blockId, stepN } (blockId)}
                <li>
                    <button
                        type="button"
                        class="block-link-chip"
                        onclick={() => onJump(blockId)}
                    >
                        <ArrowUpRight size={11} aria-hidden="true" />
                        step {stepN}
                    </button>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .expanded-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 10px 12px 16px;
        /* Inset so it aligns with the axis-name column in the row, giving a
           "test output under the test name" feel. 2ch ≈ icon column + gap. */
        padding-left: calc(2ch + 14px);
        font-family: var(--font-mono);
        font-size: 12.5px;
        color: var(--color-text-secondary);
        /* Tint the background with the verdict color so the expanded body
           visually reads as "belonging to" the row header above it. The
           `--c-rating-bg` token is set on the parent <li class="row row--*">
           by RatingTestRow, so it propagates down here. We mix with transparent
           at ~65% so the tint is clearly perceptible without overwhelming the
           long-form prose inside (rationale, details). Goes slightly stronger
           than the 50% trigger-hover tint so the two states remain
           distinguishable. */
        background: color-mix(
            in srgb,
            var(--c-rating-bg) 65%,
            transparent
        );
    }

    /* ── Rationale ──────────────────────────────────────────────── */

    .rationale {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        position: relative;
    }

    .rationale::before {
        content: "";
        flex-shrink: 0;
        width: 6px;
        height: 6px;
        margin-top: 8px;
        border-radius: 9999px;
        background: var(--c-rating-icon, var(--color-text-muted));
    }

    .rationale-text {
        font-family: var(--font-sans);
        font-size: 13px;
        line-height: 1.55;
        color: var(--color-text-primary);
        margin: 0;
        /* Cap line length to a newspaper-column measure. 65ch lands in the
           55-75 char/line range typography research identifies as optimal for
           reading speed and comprehension. On narrow containers (sidebar) the
           container width wins, so this is a no-op there. */
        max-width: 65ch;
    }

    /* ── Expected / Received (Jest-style) ────────────────────────── */

    .expected-received {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 1.5;
    }

    .er-row {
        display: flex;
        align-items: baseline;
        gap: 10px;
    }

    .er-label {
        color: var(--color-text-muted);
        min-width: 10ch;
        text-align: left;
    }

    .er-value {
        font-weight: 600;
    }

    .er-value--pass {
        color: var(--color-score-pass-label);
    }

    .er-value--concern {
        color: var(--color-score-concern-label);
    }

    .er-value--blocker {
        color: var(--color-score-blocker-label);
    }

    .er-confidence {
        color: var(--color-text-muted);
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.02em;
    }

    /* ── Section divider ─────────────────────────────────────────── */

    .section-divider {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--color-text-muted);
        font-family: var(--font-mono);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-top: 4px;
    }

    .section-divider::before,
    .section-divider::after {
        content: "";
        flex: 1;
        height: 1px;
        background: var(--color-border);
        opacity: 0.45;
    }

    .section-divider-label {
        flex-shrink: 0;
    }

    /* ── Details (rendered markdown) ─────────────────────────────── */

    .rating-details {
        font-family: var(--font-sans);
        font-size: 13px;
        line-height: 1.6;
        max-height: 480px;
        overflow-y: auto;
        /* Cap line length to a newspaper-column measure. 65ch ≈ 55-75
           chars/line in sans-serif — the typography-research sweet spot for
           reading speed. On narrow containers (sidebar) the container width
           wins, so this is a no-op there. */
        max-width: 65ch;
        /* Intentionally no mask / fade: a fade was tried but it always clipped
           the last line of short content (which is the common case). The
           native scrollbar + `max-height` is a clear-enough affordance when
           the content does overflow. */
    }

    /* Prose rules ported from the original .dialog-details :global(...) block. */
    .rating-details :global(p) {
        margin: 0 0 8px;
        color: var(--color-text-primary);
    }
    .rating-details :global(p:last-child) {
        margin-bottom: 0;
    }
    .rating-details :global(strong) {
        font-weight: 600;
        color: var(--color-text-primary);
    }
    .rating-details :global(code) {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 0.85em;
        background: color-mix(
            in srgb,
            var(--color-text-muted) 12%,
            transparent
        );
        padding: 1px 4px;
        border-radius: 3px;
    }
    .rating-details :global(ul),
    .rating-details :global(ol) {
        margin: 4px 0 8px;
        padding-left: 1.25em;
    }
    .rating-details :global(li) {
        margin-bottom: 3px;
        color: var(--color-text-primary);
    }
    .rating-details :global(h3) {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--color-text-muted);
        margin: 12px 0 4px;
    }
    .rating-details :global(pre) {
        background: var(--color-bg-tertiary);
        padding: 8px 10px;
        border-radius: 4px;
        overflow-x: auto;
        font-size: 12px;
        margin: 6px 0 8px;
    }
    .rating-details :global(pre code) {
        background: transparent;
        padding: 0;
        font-size: inherit;
    }

    /* ── References (citations, stack-trace style) ─────────────── */

    .references {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: flex-start;
    }

    .reference-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-secondary);
    }

    /* "at " prefix — mimics a Node.js/Vitest stack-trace frame. */
    .reference-item::before {
        content: "at ";
        color: var(--color-text-muted);
        font-family: var(--font-mono);
        font-size: 12px;
        letter-spacing: 0.02em;
    }

    .reference-trigger {
        display: inline-flex;
    }

    /* ── Block-link chips ────────────────────────────────────────── */

    .block-links {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .block-link-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 8px;
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
        transition:
            border-color var(--duration-snap) var(--ease-soft),
            color var(--duration-snap) var(--ease-soft),
            background var(--duration-snap) var(--ease-soft);
    }

    .block-link-chip:hover {
        border-color: var(--color-accent);
        color: var(--color-accent);
        background: color-mix(
            in srgb,
            var(--color-accent) 8%,
            transparent
        );
    }

    .block-link-chip:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
    }
</style>
