<script lang="ts">
/** One count pill on a spec panel's summary line. */
import type { Snippet } from "svelte";

interface Props {
  tone: "pass" | "concern" | "blocker" | "info" | "accent" | "muted" | "running";
  /** Shown bold before the label; the pill dims at zero. Omit for a label-only pill. */
  count?: number;
  label: string;
  /** Defaults to "{count} {label}". */
  title?: string;
  /** The icon. */
  children?: Snippet;
}

let { tone, count, label, title, children }: Props = $props();
</script>

<span
    class="count-pill count-pill--{tone}"
    class:count-pill--zero={count === 0}
    title={title ?? (count === undefined ? label : `${count} ${label}`)}
>
    {@render children?.()}
    {#if count !== undefined}
        <span class="count-num">{count}</span>
    {/if}
    <span class="count-label">{label}</span>
</span>

<style>
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

    .count-pill--pass {
        color: var(--color-score-pass-label);
        background: color-mix(in srgb, var(--color-score-pass-bg) 60%, transparent);
    }

    .count-pill--concern {
        color: var(--color-score-concern-label);
        background: color-mix(in srgb, var(--color-score-concern-bg) 60%, transparent);
    }

    .count-pill--blocker {
        color: var(--color-score-blocker-label);
        background: color-mix(in srgb, var(--color-score-blocker-bg) 60%, transparent);
    }

    .count-pill--info {
        color: var(--color-score-info-label);
        background: color-mix(in srgb, var(--color-score-info-bg) 60%, transparent);
    }

    .count-pill--accent {
        color: var(--color-accent);
        background: color-mix(in srgb, var(--color-accent) 12%, transparent);
    }

    .count-pill--muted {
        color: var(--color-text-muted);
        background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
    }

    .count-pill--running {
        color: var(--color-text-secondary);
        background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
    }

    .count-num {
        font-weight: 700;
    }

    .count-label {
        font-weight: 500;
        letter-spacing: 0.01em;
    }

    @container spec-panel (max-width: 420px) {
        .count-label {
            display: none;
        }
    }
</style>
