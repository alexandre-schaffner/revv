<script lang="ts" module>
export type UsageRowProps = {
  label: string;
  tokens: number;
  class?: string | undefined;
};
</script>

<script lang="ts">
	import { cn } from '$lib/utils.js';
	import { formatTokens } from './context-shared.js';

	let { label, tokens, class: className }: UsageRowProps = $props();

	const tokensLabel = $derived(formatTokens(tokens));
</script>

<div class={cn('flex items-center justify-between gap-3 text-xs', className)}>
	<span class="text-text-muted">{label}</span>
	<span class="font-mono tabular-nums text-text-secondary">{tokensLabel}</span>
</div>
