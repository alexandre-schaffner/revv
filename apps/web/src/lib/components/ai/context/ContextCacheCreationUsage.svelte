<script lang="ts" module>
export type ContextCacheCreationUsageProps = {
  class?: string;
  label?: string;
};
</script>

<script lang="ts">
	import UsageRow from './UsageRow.svelte';
	import { getContextState } from './context-shared.js';

	let { class: className, label = 'Cache write' }: ContextCacheCreationUsageProps = $props();

	const state = getContextState();
	const tokens = $derived(state().usage?.cacheCreationInputTokens ?? 0);
	const cost = $derived(state().cost?.cacheCreation);
</script>

{#if tokens > 0}
	<UsageRow {label} {tokens} {cost} class={className} />
{/if}
