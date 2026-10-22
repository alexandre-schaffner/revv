<script lang="ts">
import Check from "phosphor-svelte/lib/Check";
import type { Snippet } from "svelte";

// One checklist row in a filter popover: check slot, an 18px leading mark
// (avatar, team glyph, color swatch), the label, and an optional trailing
// count.

interface Props {
  checked: boolean;
  label: string;
  title?: string | undefined;
  /** A number in a pill, e.g. how many open PRs a creator has. */
  count?: number | undefined;
  onclick: () => void;
  leading: Snippet;
}

let { checked, label, title, count, onclick, leading }: Props = $props();
</script>

<button
	type="button"
	class="filter-option"
	class:filter-option--checked={checked}
	{onclick}
	aria-pressed={checked}
	{title}
>
	<span class="check-slot" aria-hidden="true">
		{#if checked}
			<Check size={12} />
		{/if}
	</span>
	<span class="leading">{@render leading()}</span>
	<span class="label" title={title ?? label}>{label}</span>
	{#if count !== undefined}
		<span class="count">{count}</span>
	{/if}
</button>

<style>
	.filter-option {
		display: grid;
		grid-template-columns: 14px 18px minmax(0, 1fr) auto;
		align-items: center;
		gap: 7px;
		width: 100%;
		min-height: 30px;
		border-radius: 6px;
		padding: 4px 6px;
		color: var(--color-text-secondary);
		text-align: left;
	}

	.filter-option:hover,
	.filter-option--checked {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.check-slot {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--color-accent);
	}

	.leading {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
	}

	.label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
	}

	.count {
		min-width: 20px;
		border-radius: 999px;
		padding: 1px 6px;
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}
</style>
