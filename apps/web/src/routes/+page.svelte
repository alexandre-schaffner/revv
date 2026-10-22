<script lang="ts">
/*
 * `/` — the repos feed.
 *
 * Landing here used to mean an empty stage with two keyboard hints, which
 * made the rail a mandatory stop: the reader had to pick a project before the
 * app told them anything. So once at least one repo is synced, this route
 * stacks every repo's homepage — hero, the queue of PRs involving the reader,
 * latest recap — into one scrollable feed. Same body as `/repo/[repoId]`
 * (RepoHomeSection), so the two can't drift.
 *
 * Feed order is the rail's order, deliberately: sorting by activity would
 * reshuffle the stack under the reader on every `prs:updated` tick, and the
 * whole point is that scanning down here matches scanning down the rail.
 *
 * The keyboard-hint hero survives as the zero-repo state, which is the only
 * case where it was ever the right thing to show.
 */

import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import RepoHomeSection from "$lib/components/repo/RepoHomeSection.svelte";
import { getReposFetchAttempted, getRepositories } from "$lib/stores/prs.svelte";

const repos = $derived(getRepositories());
const resolved = $derived(getReposFetchAttempted());
</script>

<AuthGuard>
	{#if repos.length > 0}
		<div class="feed-scroll">
			<div class="feed">
				{#each repos as repo (repo.id)}
					<RepoHomeSection {repo} variant="feed" />
				{/each}
			</div>
		</div>
	{:else if resolved}
		<div class="flex h-full flex-col items-center justify-center text-center">
			<h1 class="text-4xl font-bold tracking-tight text-text-primary">Revv</h1>
			<p class="mt-2 text-sm text-text-secondary">AI-powered code review</p>
			<p class="mt-4 flex flex-col items-center gap-1.5 text-xs text-text-muted">
				<span class="flex items-center gap-1"><kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">⌘</kbd><span class="text-text-muted">+</span><kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">P</kbd> to open a pull request</span>
				<span class="flex items-center gap-1"><kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">⌘</kbd><span class="text-text-muted">+</span><kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">⇧</kbd><span class="text-text-muted">+</span><kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">P</kbd> to open the command palette</span>
			</p>
		</div>
	{/if}
</AuthGuard>

<style>
	/* Mirrors /repo/[repoId]'s scroll port so a section reads identically in
	   both places, including the hidden scrollbar. */
	.feed-scroll {
		height: 100%;
		overflow-y: auto;
		scrollbar-width: none;
	}

	.feed-scroll::-webkit-scrollbar {
		display: none;
	}

	.feed {
		display: flex;
		flex-direction: column;
		padding: 64px 48px 48px;
		max-width: 960px;
		margin: 0 auto;
	}

	/* The gap between two repos is bigger than any gap inside one, so the
	   stack reads as separate homepages rather than one long page. The
	   hairline does the same job the whitespace does, for readers who scan
	   edges instead of rhythm. Margin (not `gap`) so the rule can be a
	   border on the section itself and only appear between siblings. */
	.feed > :global(section + section) {
		margin-top: 56px;
		padding-top: 56px;
		border-top: 1px solid var(--color-border-subtle);
	}
</style>
