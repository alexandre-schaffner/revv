<script lang="ts">
import CircleDashed from "phosphor-svelte/lib/CircleDashed";
import Spinner from "phosphor-svelte/lib/Spinner";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import { untrack } from "svelte";
import { fetchOpenIssues, getOpenIssuesState } from "$lib/stores/issues.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { openExternal } from "$lib/utils/links";

interface Props {
  repoId: string;
}

let { repoId }: Props = $props();

const VISIBLE_LIMIT = 10;

let fetched = false;
$effect(() => {
  if (!fetched && repoId) {
    fetched = true;
    void untrack(() => fetchOpenIssues(repoId));
  }
});

const state = $derived(getOpenIssuesState(repoId));
const issues = $derived(state.status === "ok" ? state.data : []);
const visibleIssues = $derived(issues.slice(0, VISIBLE_LIMIT));
const remainingCount = $derived(Math.max(0, issues.length - VISIBLE_LIMIT));

async function openIssue(url: string): Promise<void> {
  await openExternal(url);
}

function handleRetry(): void {
  void fetchOpenIssues(repoId);
}
</script>

<section class="issues-section">
	<header class="issues-header">
		<CircleDashed size={14} weight="bold" class="issues-icon" />
		<h2 class="issues-title">
			{#if state.status === "loading" && issues.length === 0}
				Loading issues…
			{:else if state.status === "error" && issues.length === 0}
				Issues
			{:else if issues.length === 1}
				1 open issue
			{:else}
				{issues.length} open issues
			{/if}
		</h2>
	</header>

	{#if state.status === "loading" && issues.length === 0}
		<div class="issues-status">
			<Spinner size={16} weight="regular" class="motion-essential-spin" aria-hidden="true" />
			<span>Loading…</span>
		</div>
	{:else if state.status === "error"}
		<div class="issues-status issues-status--error">
			<WarningCircle size={16} weight="regular" aria-hidden="true" />
			<span>Couldn't load issues.</span>
			<button type="button" class="issues-retry" onclick={handleRetry}>Retry</button>
		</div>
	{:else if issues.length === 0}
		<div class="issues-status">
			<CircleDashed size={16} weight="regular" aria-hidden="true" />
			<span>No open issues.</span>
		</div>
	{:else}
		<ul class="issues-list">
			{#each visibleIssues as issue (issue.id)}
				<li>
					<button
						type="button"
						class="issues-row"
						class:issues-row--assigned={issue.assignedToViewer}
						onclick={() => openIssue(issue.url)}
						aria-label="Issue #{issue.externalId}: {issue.title}"
					>
						<div class="issues-row-main">
							<span class="issues-row-title">{issue.title}</span>
							{#if issue.assignedToViewer}
								<span class="issues-assigned">
									<span class="issues-assigned-dot" aria-hidden="true"></span>
									Assigned
								</span>
							{/if}
						</div>
						<div class="issues-row-meta">
							<span>#{issue.externalId}</span>
							<span class="issues-sep">·</span>
							<span>by {issue.authorLogin}</span>
							<span class="issues-sep">·</span>
							<span>{formatRelativeTime(issue.updatedAt)}</span>
						</div>
					</button>
				</li>
			{/each}
		</ul>
		{#if remainingCount > 0}
			<p class="issues-footer">{remainingCount} more open</p>
		{/if}
	{/if}
</section>

<style>
	.issues-section {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.issues-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.issues-icon {
		color: var(--color-text-secondary);
		flex-shrink: 0;
	}

	.issues-title {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-primary);
		letter-spacing: -0.01em;
	}

	.issues-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		background: var(--color-bg-secondary);
		border-radius: 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.issues-status--error {
		color: var(--color-text-secondary);
	}

	.issues-retry {
		margin-left: auto;
		background: transparent;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--color-text-secondary);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
		transition: color var(--duration-quick) var(--ease-out-expo);
	}

	.issues-retry:hover {
		color: var(--color-text-primary);
	}

	.issues-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.issues-row {
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
		transition:
			background var(--duration-quick) var(--ease-out-expo),
			transform var(--duration-snap) var(--ease-out-expo);
	}

	.issues-row:hover {
		background: var(--color-bg-hover, var(--color-bg-tertiary, var(--color-bg-secondary)));
	}

	.issues-row:active {
		transform: translateY(1px);
	}

	.issues-row-main {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.issues-row-title {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-primary);
		min-width: 0;
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.issues-assigned {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		flex-shrink: 0;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-text-secondary);
		letter-spacing: 0.01em;
	}

	.issues-assigned-dot {
		width: 4px;
		height: 4px;
		border-radius: 999px;
		background: var(--revv-accent);
		flex-shrink: 0;
	}

	.issues-row-meta {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.issues-sep {
		opacity: 0.5;
	}

	.issues-footer {
		margin: 0.125rem 0 0;
		padding: 0 0.875rem;
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}
</style>
