<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import CaretRight from "phosphor-svelte/lib/CaretRight";
import type { Snippet } from "svelte";
import { gsapSlide, tokens } from "$lib/motion";

/**
 * "Show N filtered" toggle for issues the scoring pass rated low signal.
 * Count stays visible when collapsed, so a false low-signal on a real bug
 * is recoverable rather than invisible.
 */
interface Props {
  count: number;
  children: Snippet;
}

let { count, children }: Props = $props();
let expanded = $state(false);
</script>

{#if count > 0}
	<div class="low-signal">
		<button
			type="button"
			class="low-signal-toggle"
			onclick={() => (expanded = !expanded)}
			aria-expanded={expanded}
		>
			{#if expanded}
				<CaretDown size={11} aria-hidden="true" />
			{:else}
				<CaretRight size={11} aria-hidden="true" />
			{/if}
			<span>
				{expanded ? 'Hide' : 'Show'}
				{count} low-signal issue{count !== 1 ? 's' : ''}
			</span>
		</button>

		{#if expanded}
			<div class="low-signal-body" transition:gsapSlide={{ duration: tokens.smooth }}>
				{@render children()}
			</div>
		{/if}
	</div>
{/if}

<style>
	.low-signal {
		display: flex;
		flex-direction: column;
	}

	.low-signal-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 8px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		font-size: 11px;
		text-align: left;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.low-signal-toggle:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.low-signal-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 4px 0 0;
	}
</style>
