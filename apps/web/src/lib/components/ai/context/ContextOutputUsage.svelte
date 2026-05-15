<script lang="ts" module>
	export type ContextOutputUsageProps = {
		class?: string;
		label?: string;
	};
</script>

<script lang="ts">
	import UsageRow from './UsageRow.svelte';
	import { getContextState } from './context-shared.js';

	let { class: className, label = 'Output' }: ContextOutputUsageProps = $props();

	const state = getContextState();
	const tokens = $derived(state().usage?.outputTokens ?? 0);
	const cost = $derived(state().cost?.output);
</script>

{#if tokens > 0}
	<UsageRow {label} {tokens} {cost} class={className} />
{/if}
