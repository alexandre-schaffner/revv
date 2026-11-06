<script lang="ts">
import { gsapFadeY, tokens } from "$lib/motion";
import { getOpenPrsByRepoOrdered, hasActivePrListFilter } from "$lib/stores/pr-filters.svelte";
import { getOpenPrCountByRepo } from "$lib/stores/prs.svelte";
import { getSelectedPrId } from "$lib/stores/route.svelte";
import PrItem from "./PrItem.svelte";

interface Props {
  repoId: string;
}

let { repoId }: Props = $props();

const STAGGER_CAP = 20;

const prs = $derived(getOpenPrsByRepoOrdered(repoId));
const selectedPrId = $derived(getSelectedPrId());
const hasRawOpenPrs = $derived(getOpenPrCountByRepo(repoId) > 0);
const filtered = $derived(hasActivePrListFilter());
</script>

<div class="pr-list-body select-none">
	{#if prs.length === 0}
		<p class="empty">
			{#if hasRawOpenPrs && filtered}
				No matching pull requests
			{:else}
				No open pull requests
			{/if}
		</p>
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

	/* Off-screen rows skip layout and paint, so the sidebar-toggle width
	   animation only relayouts the visible ones. `contain-intrinsic-size`
	   keeps the scrollbar geometry stable. */
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
