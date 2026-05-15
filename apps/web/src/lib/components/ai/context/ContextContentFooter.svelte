<script lang="ts" module>
import type { Snippet } from "svelte";

export type ContextContentFooterProps = {
  class?: string;
  children?: Snippet;
};
</script>

<script lang="ts">
	import { cn } from '$lib/utils.js';
	import { getContextState, formatCost } from './context-shared.js';

	let { class: className, children }: ContextContentFooterProps = $props();

	const state = getContextState();
	const totalCost = $derived(state().cost?.total);
	const visible = $derived(children !== undefined || totalCost !== undefined);
	const totalLabel = $derived(formatCost(totalCost));
</script>

{#if visible}
	<div
		class={cn(
			'flex w-full items-center justify-between gap-3 bg-bg-tertiary/50 px-3 py-2 text-xs',
			className,
		)}
	>
		{#if children}
			{@render children()}
		{:else}
			<span class="text-text-muted">Total cost</span>
			<span class="font-mono tabular-nums text-text-secondary">{totalLabel}</span>
		{/if}
	</div>
{/if}
