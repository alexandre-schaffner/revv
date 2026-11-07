<script lang="ts">
/** A labelled hairline divider, then its content, inside a `SpecExpandedBody`. */
import type { Snippet } from "svelte";

interface Props {
  label: string;
  /** First section of the body: the body's own padding already spaces it. */
  lead?: boolean;
  children: Snippet;
}

let { label, lead = false, children }: Props = $props();
</script>

<div class="section-divider" class:section-divider--lead={lead} aria-hidden="true">
    <span class="section-divider-label">{label}</span>
</div>
{@render children()}

<style>
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
