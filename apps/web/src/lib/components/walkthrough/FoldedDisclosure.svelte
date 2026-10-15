<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import CaretRight from "phosphor-svelte/lib/CaretRight";
import type { Snippet } from "svelte";
import { gsapSlide, tokens } from "$lib/motion";

/**
 * The muted fold the walkthrough tucks secondary lists under (low-signal
 * issues, unraised first-pass leads): a full-width caret toggle, optional
 * controls on the same row, and the body sliding open beneath.
 */
interface Props {
  open?: boolean;
  /** The toggle's text, after the caret. */
  label: Snippet<[open: boolean]>;
  /** Controls on the toggle's row, after it. */
  aside?: Snippet;
  /** After a click flips `open`. */
  ontoggle?: (open: boolean) => void;
  children: Snippet;
}

let { open = $bindable(false), label, aside, ontoggle, children }: Props = $props();

function toggle(): void {
  open = !open;
  ontoggle?.(open);
}
</script>

<div class="fold">
	<div class="fold-header">
		<button type="button" class="fold-toggle" aria-expanded={open} onclick={toggle}>
			{#if open}
				<CaretDown size={11} aria-hidden="true" />
			{:else}
				<CaretRight size={11} aria-hidden="true" />
			{/if}
			{@render label(open)}
		</button>
		{@render aside?.()}
	</div>

	{#if open}
		<div transition:gsapSlide={{ duration: tokens.smooth }}>
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.fold {
		display: flex;
		flex-direction: column;
	}

	.fold-header {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.fold-toggle {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 6px;
		min-width: 0;
		padding: 6px 8px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-muted);
		font: inherit;
		font-size: 11px;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.fold-toggle:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.fold-toggle:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}
</style>
