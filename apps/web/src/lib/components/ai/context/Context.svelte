<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { ContextCost, ContextUsage } from './context-shared.js';

	export type { ContextCost, ContextUsage };

	export type ContextProps = {
		/** Tokens currently consumed by the conversation/job. */
		usedTokens: number;
		/** Total context window. */
		maxTokens: number;
		/** Optional breakdown — drives the body rows. */
		usage?: ContextUsage;
		/** Optional cost breakdown in USD — drives the footer when present. */
		cost?: ContextCost;
		children?: Snippet;
	};
</script>

<script lang="ts">
	import { LinkPreview } from 'bits-ui';
	import type { ContextState } from './context-shared.js';
	import { setContextState } from './context-shared.js';

	let { usedTokens, maxTokens, usage, cost, children }: ContextProps = $props();

	setContextState(() => {
		const state: ContextState = { usedTokens, maxTokens };
		if (usage !== undefined) state.usage = usage;
		if (cost !== undefined) state.cost = cost;
		return state;
	});
</script>

<LinkPreview.Root openDelay={120} closeDelay={120}>
	{@render children?.()}
</LinkPreview.Root>
