<script lang="ts">
    /*
     * IssueExpandedBody — the content that appears below an expanded issue
     * row. Styled like a rustc / clang diagnostic: a primary-span paragraph
     * leading with a verdict-tinted bullet.
     *
     * Parallels RatingExpandedBody.svelte but trimmed to what a walkthrough
     * issue actually has (no citations, no markdown details — just the
     * description).
     */
    import type { WalkthroughIssue } from "@revv/shared";

    interface Props {
        issue: WalkthroughIssue;
    }

    let { issue }: Props = $props();
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
</style>
