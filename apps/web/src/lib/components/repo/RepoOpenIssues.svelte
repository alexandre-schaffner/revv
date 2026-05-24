<script lang="ts">
import ChatCircle from "phosphor-svelte/lib/ChatCircle";
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
const allIssues = $derived(state.status === "ok" ? state.data : []);
const assignedCount = $derived(allIssues.filter((i) => i.assignedToViewer).length);

// Assigned-to-viewer pinned to the top; everything else preserves the
// server-supplied order (updatedAt desc). Stable partition, no other reshuffle —
// score-based reordering would confuse "where did that issue go?" in the
// watchtower scan.
const ordered = $derived.by(() => {
  const mine: typeof allIssues = [];
  const theirs: typeof allIssues = [];
  for (const issue of allIssues) {
    if (issue.assignedToViewer) mine.push(issue);
    else theirs.push(issue);
  }
  return [...mine, ...theirs];
});

const visibleIssues = $derived(ordered.slice(0, VISIBLE_LIMIT));
const remainingCount = $derived(Math.max(0, allIssues.length - VISIBLE_LIMIT));

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
			{#if state.status === "loading" && allIssues.length === 0}
				Loading issues…
			{:else if state.status === "error" && allIssues.length === 0}
				Issues
			{:else if allIssues.length === 1}
				1 open issue
			{:else}
				{allIssues.length} open issues
			{/if}
		</h2>
		{#if assignedCount > 0}
			<span class="issues-meta">
				<span class="issues-meta-sep" aria-hidden="true">·</span>
				{assignedCount} assigned to you
			</span>
		{/if}
	</header>

	{#if state.status === "loading" && allIssues.length === 0}
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
	{:else if allIssues.length === 0}
		<div class="issues-status">
			<CircleDashed size={16} weight="regular" aria-hidden="true" />
			<span>No open issues.</span>
		</div>
	{:else}
		<ul class="issues-grid">
			{#each visibleIssues as issue (issue.id)}
				<li>
					<button
						type="button"
						class="card"
						class:card--assigned={issue.assignedToViewer}
						onclick={() => openIssue(issue.url)}
						aria-label="Issue #{issue.externalId}: {issue.title}"
					>
						{#if issue.authorAvatarUrl}
							<img
								class="card-avatar"
								src={issue.authorAvatarUrl}
								alt=""
								width="26"
								height="26"
								loading="lazy"
								referrerpolicy="no-referrer"
							/>
						{:else}
							<span class="card-avatar card-avatar--placeholder" aria-hidden="true"></span>
						{/if}
						<div class="card-body">
							<div class="card-head">
								{#if issue.assignedToViewer}
									<span class="card-marker-dot" aria-hidden="true"></span>
								{/if}
								<span class="card-title">{issue.title}</span>
								<span class="card-id">#{issue.externalId}</span>
							</div>
							<div class="card-meta">
								<span class="card-author">{issue.authorLogin}</span>
								<span class="card-meta-sep" aria-hidden="true">·</span>
								<span class="card-time">{formatRelativeTime(issue.updatedAt)}</span>
								{#if issue.commentCount > 0}
									<span class="card-meta-sep" aria-hidden="true">·</span>
									<span class="card-comments">
										<ChatCircle size={12} weight="regular" aria-hidden="true" />
										<span class="card-comments-count">{issue.commentCount}</span>
									</span>
								{/if}
								{#if issue.assignedToViewer}
									<span class="card-pin">Assigned to you</span>
								{/if}
							</div>
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
		gap: 10px;
	}

	.issues-header {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	:global(.issues-icon) {
		color: var(--color-text-secondary);
		flex-shrink: 0;
		align-self: center;
	}

	.issues-title {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-primary);
		letter-spacing: -0.01em;
	}

	.issues-meta {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	.issues-meta-sep {
		color: var(--color-text-muted);
		opacity: 0.6;
	}

	.issues-status {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 16px;
		background: var(--color-bg-secondary);
		border-radius: 8px;
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

	/* ─────────────────────── grid ─────────────────────── */

	.issues-grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 8px;
	}

	.issues-grid > li {
		display: flex;
		min-width: 0;
	}

	/* ─────────────────────── card ───────────────────────
	   Reading-Room slip:
	   - No border at rest. Tonal step (warm-stone on warm-paper canvas)
	     carries the elevation per DESIGN.md §4 Hybrid Rule.
	   - Hover earns the Small shadow (DESIGN.md §4) — the only sanctioned
	     use of shadows: actionable content earning a single tier of lift.
	   - No avatar border ring; a clean disc reads more like identity, less
	     like a sticker.                                                 */

	.card {
		display: flex;
		flex-direction: row;
		align-items: flex-start;
		gap: 12px;
		width: 100%;
		padding: 12px 14px;
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

	.card-avatar {
		width: 26px;
		height: 26px;
		border-radius: 999px;
		flex-shrink: 0;
		object-fit: cover;
		display: block;
		margin-top: 1px;
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

	/* Assigned-to-you wash — Deep Naval at 5% over the card surface, with
	   a 26% naval hairline (only place a border appears at rest, signaling
	   ownership). Stays well under the 10% screen budget. */
	.card--assigned {
		background: color-mix(in srgb, var(--revv-accent) 5%, var(--color-bg-secondary));
		border-color: color-mix(in srgb, var(--revv-accent) 26%, transparent);
	}

	.card--assigned:hover {
		background: color-mix(in srgb, var(--revv-accent) 8%, var(--color-bg-elevated));
		border-color: color-mix(in srgb, var(--revv-accent) 40%, transparent);
	}

	.card-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.card-marker-dot {
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: var(--revv-accent);
		flex-shrink: 0;
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--revv-accent) 14%, transparent);
	}

	.card-title {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text-primary);
		min-width: 0;
		flex: 1;
		letter-spacing: -0.01em;
		line-height: 1.35;
		/* Two-line clamp at narrow column widths. Tight cards wrap, not
		   truncate — losing a long title to "…" hides the only thing the
		   reviewer needs to scan. */
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
	}

	.card--assigned .card-title {
		font-weight: 600;
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

	.card-comments {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--color-text-secondary);
	}

	.card-comments-count {
		font-feature-settings: "tnum";
	}

	.card-pin {
		margin-left: auto;
		color: var(--revv-accent);
		font-weight: 500;
		letter-spacing: 0.01em;
	}

	/* ─────────────────────── footer ─────────────────────── */

	.issues-footer {
		margin: 4px 0 0;
		padding: 0 14px;
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}
</style>
