<script lang="ts" module>
	export type ContextCacheReadUsageProps = {
		class?: string;
		label?: string;
	};
</script>

<script lang="ts">
	import UsageRow from './UsageRow.svelte';
	import { getContextState } from './context-shared.js';

	let { class: className, label = 'Cache read' }: ContextCacheReadUsageProps = $props();

	const state = getContextState();
	const tokens = $derived(state().usage?.cacheReadInputTokens ?? 0);
	const cost = $derived(state().cost?.cacheRead);
</script>

{#if tokens > 0}
	<UsageRow {label} {tokens} {cost} class={className} />
{/if}
