<script lang="ts">
import type { Snippet } from "svelte";
import FoldedDisclosure from "./FoldedDisclosure.svelte";

/**
 * "Show N filtered" toggle for issues the scoring pass rated low signal.
 * Count stays visible when collapsed, so a false low-signal on a real bug
 * is recoverable rather than invisible.
 */
interface Props {
  count: number;
  children: Snippet;
}

let { count, children }: Props = $props();
</script>

{#if count > 0}
	<FoldedDisclosure>
		{#snippet label(open)}
			<span>
				{open ? 'Hide' : 'Show'}
				{count} low-signal issue{count !== 1 ? 's' : ''}
			</span>
		{/snippet}
		<div class="low-signal-body">
			{@render children()}
		</div>
	</FoldedDisclosure>
{/if}

<style>
	.low-signal-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 4px 0 0;
	}
</style>
