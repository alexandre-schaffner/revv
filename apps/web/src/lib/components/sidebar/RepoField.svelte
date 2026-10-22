<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLInputAttributes } from "svelte/elements";

// Shared icon-prefixed input for the add-repository flows. Encapsulates the
// warm-stone field style + accent focus ring so the search, clone-location,
// path, and identity inputs read identically instead of each re-rolling the CSS.
interface Props extends Omit<HTMLInputAttributes, "class"> {
  value?: string;
  /** Leading icon, rendered inside the field on the left. */
  icon: Snippet;
  /** Optional trailing affordance (e.g. a clear button), pinned to the right. */
  trailing?: Snippet;
  /** Focus the input on mount (wrapped in rAF so it lands after view motion). */
  autofocusOnMount?: boolean;
}

let { value = $bindable(""), icon, trailing, autofocusOnMount = false, ...rest }: Props = $props();

function focusOnMount(node: HTMLInputElement) {
  if (autofocusOnMount) requestAnimationFrame(() => node.focus());
}
</script>

<div class="field" class:field--trailing={!!trailing}>
	<span class="field-icon" aria-hidden="true">{@render icon()}</span>
	<input class="field-input" bind:value use:focusOnMount {...rest} />
	{#if trailing}
		<span class="field-trailing">{@render trailing()}</span>
	{/if}
</div>

<style>
	.field {
		position: relative;
		display: flex;
		align-items: center;
		flex: 1;
		min-width: 0;
	}

	.field-icon {
		position: absolute;
		left: 11px;
		display: inline-flex;
		align-items: center;
		color: var(--color-text-muted);
		pointer-events: none;
		transition: color var(--duration-snap) var(--ease-soft);
	}

	.field:focus-within .field-icon {
		color: var(--color-text-secondary);
	}

	.field-input {
		height: 32px;
		width: 100%;
		min-width: 0;
		padding: 0 10px 0 30px;
		font-size: 12.5px;
		font-weight: 450;
		color: var(--color-text-primary);
		background: var(--color-input-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		outline: none;
		transition:
			border-color var(--duration-instant) var(--ease-soft),
			background var(--duration-instant) var(--ease-soft),
			box-shadow var(--duration-instant) var(--ease-soft);
	}

	.field--trailing .field-input {
		padding-right: 30px;
	}

	.field-input::placeholder {
		color: var(--color-text-muted);
	}

	.field-input:focus {
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
		background: var(--color-bg-primary);
		box-shadow: 0 0 0 3px var(--color-input-focus-ring);
	}

	.field-trailing {
		position: absolute;
		right: 7px;
		display: inline-flex;
		align-items: center;
	}
</style>
