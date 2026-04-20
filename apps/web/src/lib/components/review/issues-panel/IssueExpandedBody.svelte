<script lang="ts">
    /*
     * IssueExpandedBody — the content that appears below an expanded issue
     * row. Styled like a rustc / clang diagnostic: a primary-span paragraph
     * leading with a verdict-tinted bullet.
     *
     * Parallels RatingExpandedBody.svelte but trimmed to what a walkthrough
     * issue actually has (no citations, no markdown details — just the
     * description, plus a references section listing the file and any
     * walkthrough steps that explain this issue).
     */
    import { ArrowUpRight } from "@lucide/svelte";
    import type { WalkthroughIssue, WalkthroughBlock } from "@revv/shared";
    import FileBadge from "$lib/components/ui/FileBadge.svelte";

    interface Props {
        issue: WalkthroughIssue;
        /** Full ordered block list — used to resolve blockIds to step numbers. */
        blocks: WalkthroughBlock[];
        /** Jump to diff line when the FileBadge is clicked. */
        onFileClick?: ((filePath: string, line: number) => void) | undefined;
        /** Jump to a walkthrough block by id. Step chips are only rendered
         *  when this callback is supplied AND the issue has blockIds. */
        onBlockJump?: ((blockId: string) => void) | undefined;
    }

    let { issue, blocks, onFileClick, onBlockJump }: Props = $props();

    // Resolve blockIds to step numbers using the blocks array. Filter out ids
    // that don't resolve — matches the gating in IssueTestRow's original
    // trailing column and RatingExpandedBody's `resolvedBlockLinks`.
    const resolvedBlockLinks = $derived.by(() => {
        const out: { blockId: string; stepN: number }[] = [];
        for (const blockId of issue.blockIds) {
            const idx = blocks.findIndex((b) => b.id === blockId);
            if (idx >= 0) out.push({ blockId, stepN: idx + 1 });
        }
        return out;
    });

    const hasReferences = $derived(
        !!issue.filePath || (resolvedBlockLinks.length > 0 && !!onBlockJump),
    );
</script>

<div class="expanded-body">
    <!-- Primary-span — the full description with a tinted bullet, echoing
         rustc's caret-pointing-at-span. -->
    <div class="section-divider section-divider--lead" aria-hidden="true">
        <span class="section-divider-label">diagnostic</span>
    </div>

    <div class="description">
        <p class="description-text">{issue.description}</p>
    </div>

    {#if hasReferences}
        <div class="section-divider" aria-hidden="true">
            <span class="section-divider-label">references</span>
        </div>
        {#if issue.filePath}
            <ul class="references">
                <li class="reference-item">
                    <FileBadge
                        filePath={issue.filePath}
                        startLine={issue.startLine}
                        endLine={issue.endLine}
                        onclick={onFileClick
                            ? () => onFileClick(issue.filePath!, issue.startLine ?? 1)
                            : undefined}
                    />
                </li>
            </ul>
        {/if}
        {#if resolvedBlockLinks.length > 0 && onBlockJump}
            <ul class="step-chips">
                {#each resolvedBlockLinks as { blockId, stepN } (blockId)}
                    <li>
                        <button
                            type="button"
                            class="step-chip"
                            onclick={() => onBlockJump?.(blockId)}
                        >
                            <ArrowUpRight size={10} aria-hidden="true" />
                            step {stepN}
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
    {/if}
</div>

<style>
    .expanded-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 10px 12px 16px;
        /* Align under the axis-name column (2ch + 14px) — "test output under
           the test name" feel, mirroring RatingExpandedBody. */
        padding-left: calc(2ch + 14px);
        font-family: var(--font-mono);
        font-size: 12.5px;
        color: var(--color-text-secondary);
        /* Verdict-tinted bg — parent IssueTestRow sets --c-row-bg per severity
           (the same pre-mixed bg token that RatingExpandedBody uses via
           --c-rating-bg), producing a softer tint than the trigger header's 8%
           icon-color mix. */
        background: var(--c-row-bg, var(--color-bg-secondary));
    }

    /* ── Primary-span description (sans, readable) ────────────── */

    .description {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        position: relative;
    }



    .description-text {
        font-family: var(--font-sans);
        font-size: 13px;
        line-height: 1.55;
        color: var(--color-text-primary);
        margin: 0;
        max-width: 65ch;
    }

    /* ── Section divider — uppercase mono, echo RatingExpandedBody ─ */

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

    /* ── References (files, stack-trace style) ────────────────── */

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

    /* ── Step chips — navigate to the walkthrough block(s) that
       explain this issue. Mirrors RatingExpandedBody's block-links
       but uses the severity-tinted palette like the trigger header. ─ */

    .step-chips {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .step-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 8px;
        border-radius: 9999px;
        border: 1px solid color-mix(in srgb, var(--c-gutter-color) 45%, transparent);
        background: color-mix(in srgb, var(--c-gutter-color) 8%, transparent);
        color: var(--c-gutter-color);
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

    .step-chip:hover {
        border-color: var(--c-gutter-color);
        background: color-mix(in srgb, var(--c-gutter-color) 15%, transparent);
    }

    .step-chip:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
    }
</style>
