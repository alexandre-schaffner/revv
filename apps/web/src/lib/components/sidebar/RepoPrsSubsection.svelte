<script lang="ts">
import { GitPullRequest } from "@lucide/svelte";
import { fly, slide } from "svelte/transition";
import {
  getNeedsYourReviewByRepo,
  getOpenPrsByRepoOrdered,
  getSelectedPrId,
} from "$lib/stores/prs.svelte";
import PrItem from "./PrItem.svelte";
import SubsectionHeader from "./SubsectionHeader.svelte";

interface Props {
  repoId: string;
  navParent: string;
}

let { repoId, navParent }: Props = $props();

const STAGGER_CAP = 20;

// Defaults open so the user lands on the PRs as soon as the outer
// repo group expands — they're the primary content of each repo.
let expanded = $state(true);

function toggle(): void {
  expanded = !expanded;
}

const prs = $derived(getOpenPrsByRepoOrdered(repoId));
const reviewIds = $derived(
  new Set((getNeedsYourReviewByRepo().get(repoId) ?? []).map((p) => p.id)),
);
const selectedPrId = $derived(getSelectedPrId());

const navId = $derived(`prs:repo:${repoId}`);
</script>

<div class="select-none">
	<SubsectionHeader
		icon={GitPullRequest}
		label="PRs"
		count={prs.length}
		expanded={expanded}
		onToggle={toggle}
		{navId}
		navParent={navParent}
	/>

	{#if expanded}
		<div class="body" transition:slide={{ duration: 220 }}>
			{#if prs.length === 0}
				<p class="empty">No open pull requests</p>
			{:else}
				{#each prs as pr, i (pr.id)}
					<div in:fly={{ y: 6, duration: 160, delay: Math.min(i, STAGGER_CAP) * 25 }}>
						<PrItem
							{pr}
							isSelected={selectedPrId === pr.id}
							pinned={reviewIds.has(pr.id)}
							navPrefix="pr"
						/>
					</div>
				{/each}
			{/if}
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
	.empty {
		margin: 0;
		padding: 6px 10px;
		font-size: 11px;
		color: var(--color-text-muted);
	}
</style>
