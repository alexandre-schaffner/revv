<script lang="ts">
import GitPullRequest from "phosphor-svelte/lib/GitPullRequest";
import Loader2 from "phosphor-svelte/lib/Spinner";
import User from "phosphor-svelte/lib/User";
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
		<GitPullRequest size={14} weight="fill" class="tagged-icon" />
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
		<div class="tagged-status">
			<Loader2 size={16} weight="regular" class="motion-essential-spin" aria-hidden="true" />
			<span>Loading…</span>
		</div>
	{:else if prs.length === 0}
		<div class="tagged-status">
			<User size={16} weight="regular" aria-hidden="true" />
			<span>No pull requests need your attention.</span>
		</div>
	{:else}
		<ul class="tagged-grid">
			{#each prs as pr (pr.id)}
				<li>
					<button
						type="button"
						class="card"
						class:card--draft={pr.isDraft}
						onclick={() => handleClick(pr.id)}
						aria-label="PR #{pr.externalId}: {pr.title}"
					>
						{#if pr.authorAvatarContent}
							<img
								class="card-avatar"
								src={pr.authorAvatarContent}
								alt=""
								width="28"
								height="28"
								loading="lazy"
							/>
						{:else}
							<span class="card-avatar card-avatar--placeholder" aria-hidden="true"></span>
						{/if}
						<div class="card-body">
							<div class="card-head">
								<span class="card-title">{pr.title}</span>
								<span class="card-id">#{pr.externalId}</span>
							</div>
							<div class="card-meta">
								<span class="card-author">{pr.authorLogin}</span>
								<span class="card-meta-sep" aria-hidden="true">·</span>
								<span class="card-time">{formatRelativeTime(pr.updatedAt)}</span>
								<span class="card-meta-sep" aria-hidden="true">·</span>
								<span class="card-diff">
									<span class="card-diff-add">+{pr.additions}</span>
									<span class="card-diff-del">−{pr.deletions}</span>
								</span>
								{#if pr.isDraft}
									<span class="card-draft">Draft</span>
								{/if}
							</div>
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
		gap: 10px;
	}

	.tagged-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	:global(.tagged-icon) {
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

	.tagged-status {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 16px;
		background: var(--color-bg-secondary);
		border-radius: 8px;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	/* ─────────────────────── grid ─────────────────────── */

	.tagged-grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	/* ─────────────────────── card (mirrors RepoOpenIssues) ─────────────────── */

	.card {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 12px 16px;
		text-align: left;
		background: var(--color-bg-secondary);
		border: 1px solid transparent;
		border-radius: 10px;
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition:
			background var(--duration-quick) var(--ease-out-expo),
			border-color var(--duration-quick) var(--ease-out-expo),
			box-shadow var(--duration-quick) var(--ease-out-expo),
			transform var(--duration-snap) var(--ease-out-expo);
	}

	.card:hover {
		background: var(--color-bg-elevated);
		box-shadow: var(--revv-shadow-sm);
		transform: translateY(-1px);
	}

	.card:active {
		transform: translateY(0);
		box-shadow: none;
		transition-duration: var(--duration-snap);
	}

	.card:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px var(--revv-input-focus-ring);
	}

	/* Draft PRs read softer than the room they sit in — a tonal half-step
	   down from the regular card surface, no extra border. Conveys "not
	   ready" without competing visually with non-draft cards. */
	.card--draft {
		background: color-mix(in srgb, var(--color-bg-secondary) 92%, transparent);
		opacity: 0.92;
	}

	.card--draft:hover {
		opacity: 1;
	}

	.card-avatar {
		width: 28px;
		height: 28px;
		border-radius: 999px;
		flex-shrink: 0;
		object-fit: cover;
		display: block;
		background: var(--color-bg-tertiary);
	}

	.card-avatar--placeholder {
		background: var(--color-bg-tertiary);
	}

	.card-body {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
		flex: 1;
	}

	.card-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.card-title {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text-primary);
		min-width: 0;
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		letter-spacing: -0.01em;
		line-height: 1.35;
	}

	.card-id {
		flex-shrink: 0;
		font-size: 0.75rem;
		font-feature-settings: "tnum";
		color: var(--color-text-muted);
	}

	.card-meta {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		font-size: 0.75rem;
		color: var(--color-text-muted);
		line-height: 1.4;
	}

	.card-author {
		color: var(--color-text-secondary);
		font-weight: 500;
	}

	.card-meta-sep {
		opacity: 0.5;
	}

	.card-time {
		font-feature-settings: "tnum";
	}

	.card-diff {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-feature-settings: "tnum";
	}

	.card-diff-add {
		color: var(--color-success);
	}

	.card-diff-del {
		color: var(--color-danger);
	}

	.card-draft {
		margin-left: auto;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-text-secondary);
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--color-bg-tertiary);
	}
</style>
