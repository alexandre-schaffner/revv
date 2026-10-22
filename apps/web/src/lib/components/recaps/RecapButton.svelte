<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";
import { gsapPress } from "$lib/motion";

/**
 * The one button shape on the recap surface.
 *
 * Before this existed the archive alone shipped three: a 28px bordered icon
 * square for the month arrows, a 28px bordered pill for "Today", and a 30px
 * filled chip for the panel actions — all hand-rolled, all slightly different.
 * Every in-flow recap button now comes from here, so the header pager, the
 * archive toolbar and the selection strip are visibly the same control.
 *
 * `GlassPill` remains the separate, deliberate vocabulary for *floating*
 * chrome (the bottom action bar). Chrome that hovers over content and chrome
 * that sits in it should not look identical.
 */
interface Props extends HTMLButtonAttributes {
  /** `primary` is the accent chip — at most one per view. */
  variant?: "default" | "primary";
  /** Square, for a lone icon. */
  icon?: boolean;
  class?: string;
  children: Snippet;
}

let {
  variant = "default",
  icon = false,
  class: extraClass = "",
  children,
  ...rest
}: Props = $props();
</script>

<button
	type="button"
	class="recap-btn {extraClass}"
	class:recap-btn--primary={variant === "primary"}
	class:recap-btn--icon={icon}
	use:gsapPress
	{...rest}
>
	{@render children()}
</button>

<style>
	.recap-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		/* `min-height`, never `height`: these labels sit in narrow columns and
		   a wrap has to grow the control rather than spill out of it. */
		min-height: 1.75rem;
		padding: 0.25rem 0.625rem;
		background: transparent;
		border: 1px solid var(--color-border-subtle);
		border-radius: 0.375rem;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 500;
		line-height: 1.35;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition:
			background var(--duration-quick) var(--ease-out-expo),
			border-color var(--duration-quick) var(--ease-out-expo),
			color var(--duration-quick) var(--ease-out-expo);
	}

	.recap-btn--icon {
		width: 1.75rem;
		padding: 0;
	}

	.recap-btn:hover:not(:disabled) {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.recap-btn:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.recap-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	/* The accent-chip tokens rather than a flat `--color-accent` fill: the
	   accent flips from dark teal (light theme) to light teal (dark theme), so
	   any fixed foreground colour fails contrast in one of them. */
	.recap-btn--primary {
		background: var(--color-accent-chip-bg);
		border-color: var(--color-accent-chip-border);
		color: var(--color-accent-chip-fg);
	}

	.recap-btn--primary:hover:not(:disabled) {
		background: var(--color-accent-chip-bg-hover);
		border-color: var(--color-accent-chip-border-hover);
		color: var(--color-accent-chip-fg);
	}
</style>
