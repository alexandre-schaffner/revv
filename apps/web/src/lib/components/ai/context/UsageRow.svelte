<script lang="ts" module>
	export type UsageRowProps = {
		label: string;
		tokens: number;
		cost?: number | undefined;
		class?: string | undefined;
	};
</script>

<script lang="ts">
	import { cn } from '$lib/utils.js';
	import { formatTokens, formatCost } from './context-shared.js';

	let { label, tokens, cost, class: className }: UsageRowProps = $props();

	const tokensLabel = $derived(formatTokens(tokens));
	const costLabel = $derived(formatCost(cost));
</script>

<div class={cn('flex items-center justify-between gap-3 text-xs', className)}>
	<span class="text-text-muted">{label}</span>
	<span class="flex items-center gap-2 font-mono tabular-nums text-text-secondary">
		<span>{tokensLabel}</span>
		{#if costLabel}
			<span class="text-text-muted">·</span>
			<span class="text-text-muted">{costLabel}</span>
		{/if}
	</span>
</div>
