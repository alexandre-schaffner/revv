<script lang="ts" module>
import type { Snippet } from "svelte";
import type { ContextUsage } from "./context-shared.js";

export type ContextProps = {
  /** Tokens currently consumed by the conversation/job. */
  usedTokens: number;
  /** Total context window. */
  maxTokens: number;
  /** Optional breakdown — drives the body rows. */
  usage?: ContextUsage;
  children?: Snippet;
};
</script>

<script lang="ts">
	import { LinkPreview } from 'bits-ui';
	import type { ContextState } from './context-shared.js';
	import { setContextState } from './context-shared.js';

	let { usedTokens, maxTokens, usage, children }: ContextProps = $props();

	setContextState(() => {
		const state: ContextState = { usedTokens, maxTokens };
		if (usage !== undefined) state.usage = usage;
		return state;
	});
</script>

<LinkPreview.Root openDelay={120} closeDelay={120}>
	{@render children?.()}
</LinkPreview.Root>
