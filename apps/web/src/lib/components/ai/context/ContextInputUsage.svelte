<script lang="ts" module>
export type ContextInputUsageProps = {
  class?: string;
  label?: string;
};
</script>

<script lang="ts">
	import UsageRow from './UsageRow.svelte';
	import { getContextState } from './context-shared.js';

	let { class: className, label = 'Input' }: ContextInputUsageProps = $props();

	const state = getContextState();
	const tokens = $derived(state().usage?.inputTokens ?? 0);
	const cost = $derived(state().cost?.input);
</script>

{#if tokens > 0}
	<UsageRow {label} {tokens} {cost} class={className} />
{/if}
