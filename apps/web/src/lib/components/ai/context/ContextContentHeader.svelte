<script lang="ts" module>
import type { Snippet } from "svelte";

export type ContextContentHeaderProps = {
  class?: string;
  children?: Snippet;
};
</script>

<script lang="ts">
	import { cn } from '$lib/utils.js';
	import Progress from '$lib/components/ui/progress/progress.svelte';
	import {
		getContextState,
		formatTokens,
		formatPercent,
	} from './context-shared.js';

	let { class: className, children }: ContextContentHeaderProps = $props();

	const state = getContextState();
	const ratio = $derived(
		state().maxTokens > 0 ? state().usedTokens / state().maxTokens : 0,
	);
	// Clamp for the bar width — occupancy can momentarily exceed the (possibly
	// fallback) window. The percent label clamps independently via formatPercent.
	const barPercent = $derived(Math.round(Math.max(0, Math.min(1, ratio)) * 100));
	const usedLabel = $derived(formatTokens(state().usedTokens));
	const maxLabel = $derived(formatTokens(state().maxTokens));
	const percentLabel = $derived(formatPercent(ratio));
</script>

<div class={cn('flex w-full flex-col gap-2 p-3', className)}>
	{#if children}
		{@render children()}
	{:else}
		<div class="flex items-center justify-between gap-3 text-xs">
			<span class="font-medium text-text-primary">{percentLabel}</span>
			<span class="font-mono text-text-muted">
				{usedLabel} <span class="opacity-60">/</span>
				{maxLabel}
			</span>
		</div>
		<Progress value={barPercent} class="h-1.5" />
	{/if}
</div>
