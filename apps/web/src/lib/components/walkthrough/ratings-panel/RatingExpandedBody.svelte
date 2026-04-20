<script lang="ts">
    import { ArrowUpRight } from "@lucide/svelte";
    import type {
        WalkthroughRating,
        WalkthroughBlock,
        Verdict,
        Confidence,
    } from "@revv/shared";
    import { RATING_AXIS_LABELS } from "@revv/shared";
    import FileBadge from "$lib/components/ui/FileBadge.svelte";
    import * as Tooltip from "$lib/components/ui/tooltip";
    import { jumpToDiffLine } from "$lib/stores/review.svelte";
    import { renderMarkdown } from "$lib/utils/markdown";

    interface Props {
        rating: WalkthroughRating;
        /** Full ordered block list — used to resolve blockIds to step numbers. */
        blocks: WalkthroughBlock[];
        onJump: (blockId: string) => void;
        /** When `true`, render the uppercase axis-name title above the Status
         *  divider. Grid popovers set this so the header echoes the card that
         *  opened it; the list view leaves it off because the row header
         *  already shows the axis name one level up. Defaults to `false`. */
        showTitle?: boolean;
    }

    let { rating, blocks, onJump, showTitle = false }: Props = $props();

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
    <!-- Score title — echoes the grid cell's axis label so the popover header
         provides visual continuity with the card it opened from. Rendered
         uppercase mono like the cell but upgraded to primary text color for
         prominence (the cell uses muted). Gated on `showTitle` because the
         list-view row already shows the axis name one level up (in the row
         header), so duplicating it inside the expanded body would be noise. -->
    {#if showTitle}
        <h3 class="score-title">
            <span class="score-title-dot" aria-hidden="true"></span>
            {RATING_AXIS_LABELS[rating.axis]}
        </h3>
    {/if}

    <!-- Status section — always leads. For concern/blocker verdicts it opens
         with a Jest-style Expected/Received diff ("you got X, we wanted pass")
         and then the rationale reads as the explanation. For pass verdicts we
         skip the Expected/Received block and the rationale becomes the whole
         status body. The `status` divider mirrors the `details`/`references`
         dividers below so all three sections share a visual header. -->
    <div class="section-divider section-divider--lead" aria-hidden="true">
        <span class="section-divider-label">status</span>
    </div>

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

    <div class="rationale">
        <p class="rationale-text">{rating.rationale}</p>
    </div>

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
        padding: 16px 12px;
        /* Inset so it aligns with the axis-name column in the row, giving a
           "test output under the test name" feel. 2ch ≈ icon column + gap. */
        padding-left: calc(2ch + 14px);
        font-family: var(--font-mono);
        font-size: 12.5px;
        color: var(--color-text-secondary);
        /* Default to the pre-mixed verdict tint (--c-rating-bg = bg-secondary
           + verdict 4%). The inline list row overrides this with a darker
           variant via --c-rating-expanded-bg to match the Comments panel's
           "inset drawer" treatment; the grid popover keeps the lighter tint
           since the popover chrome already provides the elevation contrast. */
         background: var(--color-bg-secondary);
    }

    /* ── Rationale ──────────────────────────────────────────────── */

    .rationale {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        position: relative;
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

    /* ── Score title (axis name, heads the popover) ──────────────── */

    .score-title {
        /* Mirrors the grid cell's `.cell-label` treatment (uppercase mono)
           but steps the color up from muted → verdict-tinted label color and
           the size up from 10.5px → 12px so the popover header reads as more
           authoritative than the card it opened from. Zero margin because the
           flex parent `.expanded-body` already provides `gap: 12px` between
           children. */
        margin: 0;
        font-family: var(--font-mono);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--c-rating-label);
        display: flex;
        align-items: center;
    }

    .score-title-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--c-rating-icon);
        margin-right: 7px;
        flex-shrink: 0;
        position: relative;
        top: -1px;
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

    /* The lead divider (Status) sits at the very top of the popover — the
       container's own top padding already provides breathing room, so the
       4px extra stacks unnecessarily. Zero it out for this one variant. */
    .section-divider--lead {
        margin-top: 0;
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
