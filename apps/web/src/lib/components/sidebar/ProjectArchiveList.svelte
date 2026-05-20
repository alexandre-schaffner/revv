<script lang="ts">
import Archive from "phosphor-svelte/lib/Archive";
import ChevronDown from "phosphor-svelte/lib/CaretDown";
import ChevronRight from "phosphor-svelte/lib/CaretRight";
import { fly, slide } from "svelte/transition";
import {
  fetchMoreArchived,
  getArchivedByRepo,
  getArchivedLoadingMore,
  getArchivedNextCursor,
  getSelectedPrId,
} from "$lib/stores/prs.svelte";
import PrItem from "./PrItem.svelte";

interface Props {
  repoId: string;
}

let { repoId }: Props = $props();

const STAGGER_CAP = 20;
const STORAGE_PREFIX = "revv:archive-open:";

let expanded = $state(false);

// Per-repo persistence — different repos have different archive states,
// and "I left it open last time" is the user's intent. Localstorage
// rather than the store because it's chrome state, not data state.
$effect(() => {
  if (typeof localStorage === "undefined") return;
  const stored = localStorage.getItem(`${STORAGE_PREFIX}${repoId}`);
  expanded = stored === "1";
});

function toggle(): void {
  expanded = !expanded;
  if (typeof localStorage !== "undefined") {
    if (expanded) localStorage.setItem(`${STORAGE_PREFIX}${repoId}`, "1");
    else localStorage.removeItem(`${STORAGE_PREFIX}${repoId}`);
  }
}

const archivedPrs = $derived(getArchivedByRepo().get(repoId) ?? []);
const selectedPrId = $derived(getSelectedPrId());
const nextCursor = $derived(getArchivedNextCursor());
const loadingMore = $derived(getArchivedLoadingMore());

// Hide the toggle entirely when there's nothing to show — keeps the
// column clean for fresh repos and reduces visual noise.
const visible = $derived(archivedPrs.length > 0 || nextCursor !== null);
</script>

{#if visible}
	<div class="archive-section select-none">
		<button
			type="button"
			class="archive-toggle"
			class:archive-toggle--expanded={expanded}
			onclick={toggle}
			aria-expanded={expanded}
		>
			{#if expanded}
				<ChevronDown size={12} aria-hidden="true" />
			{:else}
				<ChevronRight size={12} aria-hidden="true" />
			{/if}
			<Archive size={12} aria-hidden="true" />
			<span class="archive-label">Show closed</span>
			{#if archivedPrs.length > 0}
				<span class="archive-count">{archivedPrs.length}</span>
			{/if}
		</button>

		{#if expanded}
			<div class="archive-body" transition:slide={{ duration: 200 }}>
				{#if archivedPrs.length === 0}
					<p class="empty">No closed pull requests</p>
				{:else}
					{#each archivedPrs as pr, i (pr.id)}
						<div in:fly={{ y: 6, duration: 160, delay: Math.min(i, STAGGER_CAP) * 25 }}>
							<PrItem
								{pr}
								isSelected={selectedPrId === pr.id}
								variant="archived"
								navPrefix="archive"
							/>
						</div>
					{/each}
				{/if}

				{#if nextCursor !== null}
					<button
						type="button"
						class="load-more"
						disabled={loadingMore}
						onclick={() => fetchMoreArchived()}
					>
						{loadingMore ? 'Loading…' : 'Load more'}
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.archive-section {
		border-top: 1px solid var(--color-border-subtle, var(--color-border));
		padding: 6px 4px 4px;
	}

	.archive-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 8px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		font-size: 11px;
		text-align: left;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.archive-toggle:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.archive-toggle--expanded {
		color: var(--color-text-secondary);
	}

	.archive-label {
		font-weight: 500;
	}

	.archive-count {
		margin-left: auto;
		font-size: 10px;
		color: var(--color-text-muted);
	}

	.archive-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 4px 0 0;
	}

	.empty {
		margin: 0;
		padding: 8px 10px;
		font-size: 11px;
		color: var(--color-text-muted);
		text-align: center;
	}

	.load-more {
		margin: 6px 6px 0;
		padding: 6px 8px;
		border: none;
		border-radius: 5px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		font-size: 11px;
		text-align: left;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.load-more:hover:not(:disabled) {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.load-more:disabled {
		cursor: default;
		opacity: 0.6;
	}
</style>
