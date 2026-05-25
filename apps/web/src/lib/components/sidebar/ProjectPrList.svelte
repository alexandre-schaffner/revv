<script lang="ts">
import { gsapFadeY, tokens } from "$lib/motion";
import { getOpenPrsByRepoOrdered, getSelectedPrId } from "$lib/stores/prs.svelte";
import PrItem from "./PrItem.svelte";

interface Props {
  repoId: string;
}

let { repoId }: Props = $props();

const STAGGER_CAP = 20;

const prs = $derived(getOpenPrsByRepoOrdered(repoId));
const selectedPrId = $derived(getSelectedPrId());
</script>

<div class="pr-list-body select-none">
	{#if prs.length === 0}
		<p class="empty">No open pull requests</p>
	{:else}
		{#each prs as pr, i (pr.id)}
			<div
				class="pr-list-row"
				in:gsapFadeY={{
					y: 6,
					duration: tokens.quick,
					delay: Math.min(i, STAGGER_CAP) * tokens.stagger.tight,
				}}
			>
				<PrItem
					{pr}
					isSelected={selectedPrId === pr.id}
					navPrefix="pr"
				/>
			</div>
		{/each}
	{/if}
</div>

<style>
	.pr-list-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 4px;
	}

	/* Skip layout and paint for off-screen PR rows. With hundreds of PRs
	   open this is what makes the sidebar-toggle width animation cheap:
	   the browser only relayouts the ~20 rows currently in the viewport
	   instead of all of them on every frame. `contain-intrinsic-size`
	   reserves a placeholder height so scrollbar geometry stays stable. */
	.pr-list-row {
		content-visibility: auto;
		contain-intrinsic-size: auto 48px;
	}

	.empty {
		margin: 0;
		padding: 16px 10px;
		font-size: 11px;
		color: var(--color-text-muted);
		text-align: center;
	}
</style>
