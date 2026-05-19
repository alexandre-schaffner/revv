<script lang="ts">
import { GitPullRequest, Loader2, User } from "@lucide/svelte";
import { untrack } from "svelte";
import {
  fetchTaggedPrs,
  getTaggedPrs,
  getTaggedPrsLoading,
  selectPr,
} from "$lib/stores/prs.svelte";
import { setSidebarView } from "$lib/stores/sidebar.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";

interface Props {
  repoId: string;
}

let { repoId }: Props = $props();

let fetched = false;
$effect(() => {
  if (!fetched && repoId) {
    fetched = true;
    void untrack(() => fetchTaggedPrs(repoId));
  }
});

const prs = $derived(getTaggedPrs(repoId));
const loading = $derived(getTaggedPrsLoading(repoId));

function handleClick(prId: string) {
  selectPr(prId);
  setSidebarView("files");
}
</script>

<section class="tagged-section">
	<header class="tagged-header">
		<GitPullRequest size={14} class="tagged-icon" />
		<h2 class="tagged-title">
			{#if loading && prs.length === 0}
				Loading pull requests…
			{:else if prs.length === 1}
				1 pull request needs your attention
			{:else}
				{prs.length} pull requests need your attention
			{/if}
		</h2>
	</header>

	{#if loading && prs.length === 0}
		<div class="tagged-loading">
			<Loader2 size={16} class="animate-spin" aria-hidden="true" />
			<span>Loading…</span>
		</div>
	{:else if prs.length === 0}
		<div class="tagged-empty">
			<User size={16} aria-hidden="true" />
			<p>No pull requests need your attention — you're all caught up!</p>
		</div>
	{:else}
		<ul class="tagged-list">
			{#each prs as pr (pr.id)}
				<li>
					<button
						type="button"
						class="tagged-row"
						onclick={() => handleClick(pr.id)}
						aria-label="PR #{pr.externalId}: {pr.title}"
					>
						<div class="tagged-row-main">
							<span class="tagged-row-title">{pr.title}</span>
							{#if pr.isDraft}
								<span class="tagged-badge tagged-badge--draft">Draft</span>
							{/if}
						</div>
						<div class="tagged-row-meta">
							<span>#{pr.externalId}</span>
							<span class="tagged-sep">·</span>
							<span>by {pr.authorLogin}</span>
							<span class="tagged-sep">·</span>
							<span>{formatRelativeTime(pr.updatedAt)}</span>
						</div>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.tagged-section {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.tagged-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.tagged-icon {
		color: var(--color-text-secondary);
		flex-shrink: 0;
	}

	.tagged-title {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-primary);
		letter-spacing: -0.01em;
	}

	.tagged-loading,
	.tagged-empty {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		background: var(--color-bg-secondary);
		border-radius: 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.tagged-empty p {
		margin: 0;
	}

	.tagged-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.tagged-row {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		width: 100%;
		padding: 0.625rem 0.875rem;
		text-align: left;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border-subtle);
		border-radius: 0.5rem;
		cursor: pointer;
		transition: background var(--duration-quick) var(--ease-out-expo);
	}

	.tagged-row:hover {
		background: var(--color-bg-hover, var(--color-bg-tertiary, var(--color-bg-secondary)));
	}

	.tagged-row-main {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.tagged-row-title {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-primary);
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tagged-badge {
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		flex-shrink: 0;
	}

	.tagged-badge--draft {
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
	}

	.tagged-row-meta {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.tagged-sep {
		opacity: 0.5;
	}
</style>
