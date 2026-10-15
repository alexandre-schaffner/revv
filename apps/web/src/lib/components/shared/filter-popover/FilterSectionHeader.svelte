<script lang="ts">
import CaretRight from "phosphor-svelte/lib/CaretRight";

/** A collapsible section header in a filter popover, with its row count. */
interface Props {
  label: string;
  count: number;
  collapsed: boolean;
  ontoggle: () => void;
}

let { label, count, collapsed, ontoggle }: Props = $props();
</script>

<button type="button" class="section-header" onclick={ontoggle} aria-expanded={!collapsed}>
	<span class="caret" class:caret--open={!collapsed} aria-hidden="true">
		<CaretRight size={10} />
	</span>
	<span class="section-label">{label}</span>
	<span class="section-count">{count}</span>
</button>

<style>
	.section-header {
		display: flex;
		align-items: center;
		gap: 5px;
		width: 100%;
		padding: 3px 4px;
		border-radius: 6px;
		color: var(--color-text-muted);
		text-align: left;
	}

	.section-header:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.caret {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: transform var(--duration-snap) var(--ease-soft);
	}

	.caret--open {
		transform: rotate(90deg);
	}

	.section-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.section-count {
		min-width: 18px;
		margin-left: auto;
		border-radius: 999px;
		padding: 1px 6px;
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}
</style>
