<script lang="ts">
import { Archive } from "@lucide/svelte";
import { fly, slide } from "svelte/transition";
import { getArchivedByRepo, getSelectedPrId } from "$lib/stores/prs.svelte";
import PrItem from "./PrItem.svelte";
import SubsectionHeader from "./SubsectionHeader.svelte";

interface Props {
  repoId: string;
  navParent: string;
}

let { repoId, navParent }: Props = $props();

const STAGGER_CAP = 20;

let expanded = $state(false);

function toggle(): void {
  expanded = !expanded;
}

const prs = $derived(getArchivedByRepo().get(repoId) ?? []);
const selectedPrId = $derived(getSelectedPrId());

const navId = $derived(`archive:repo:${repoId}`);
</script>

<div class="select-none">
	<SubsectionHeader
		icon={Archive}
		label="Archives"
		count={prs.length}
		expanded={expanded}
		onToggle={toggle}
		{navId}
		navParent={navParent}
	/>

	{#if expanded}
		<div class="body" transition:slide={{ duration: 220 }}>
			{#each prs as pr, i (pr.id)}
				<div in:fly={{ y: 6, duration: 160, delay: Math.min(i, STAGGER_CAP) * 25 }}>
					<PrItem
						{pr}
						isSelected={selectedPrId === pr.id}
						variant="archived"
						navPrefix="archive"
					/>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.body {
		margin-left: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 2px;
		border-left: 1px solid var(--color-border-subtle);
		padding-left: 0.5rem;
	}
</style>
