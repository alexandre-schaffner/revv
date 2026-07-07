<script lang="ts">
import Archive from "phosphor-svelte/lib/Archive";
import ChevronDown from "phosphor-svelte/lib/CaretDown";
import ChevronRight from "phosphor-svelte/lib/CaretRight";
import { untrack } from "svelte";
import { gsapFadeY, gsapSlide, tokens } from "$lib/motion";
import {
  fetchArchivedPrsForRepo,
  fetchMoreArchived,
  getArchivedFetchStateForRepo,
  getArchivedLoadingMore,
  getArchivedNextCursor,
  getArchivedPrsByRepo,
  getRawArchivedPrsByRepo,
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

$effect(() => {
  const id = repoId;
  void untrack(() => fetchArchivedPrsForRepo(id));
});

function toggle(): void {
  expanded = !expanded;
  if (typeof localStorage !== "undefined") {
    if (expanded) localStorage.setItem(`${STORAGE_PREFIX}${repoId}`, "1");
    else localStorage.removeItem(`${STORAGE_PREFIX}${repoId}`);
  }
}

const rawArchivedPrs = $derived(getRawArchivedPrsByRepo(repoId));
const archivedPrs = $derived(getArchivedPrsByRepo(repoId));
const selectedPrId = $derived(getSelectedPrId());
const nextCursor = $derived(getArchivedNextCursor(repoId));
const loadingMore = $derived(getArchivedLoadingMore(repoId));
const fetchState = $derived(getArchivedFetchStateForRepo(repoId));

// Hide the toggle entirely when there's nothing to show — keeps the
// column clean for fresh repos and reduces visual noise.
const visible = $derived(
  rawArchivedPrs.length > 0 || nextCursor !== null || fetchState !== "loaded",
);
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
				<ChevronRight size={12} weight="fill" aria-hidden="true" />
			{/if}
			<Archive size={12} aria-hidden="true" />
			<span class="archive-label">Show closed</span>
			{#if archivedPrs.length > 0}
				<span class="archive-count">{archivedPrs.length}</span>
			{/if}
		</button>

		{#if expanded}
			<div class="archive-body" transition:gsapSlide={{ duration: tokens.smooth }}>
				{#if archivedPrs.length === 0}
					<p class="empty">
						{fetchState === "loading" ? 'Loading closed pull requests' : 'No closed pull requests'}
					</p>
				{:else}
					{#each archivedPrs as pr, i (pr.id)}
						<div
							class="archive-row"
							in:gsapFadeY={{
								y: 6,
								duration: tokens.quick,
								delay: Math.min(i, STAGGER_CAP) * tokens.stagger.tight,
							}}
						>
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
						onclick={() => fetchMoreArchived(repoId)}
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

	/* Off-screen rows skip layout / paint — keeps sidebar-width animations
	   cheap even with hundreds of archived PRs loaded. */
	.archive-row {
		content-visibility: auto;
		contain-intrinsic-size: auto 48px;
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
