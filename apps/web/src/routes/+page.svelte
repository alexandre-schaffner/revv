<script lang="ts">
/*
 * Feed order is the rail's order, deliberately: sorting by activity would
 * reshuffle the stack under the reader on every `prs:updated` tick, and
 * scanning down here should match scanning down the rail.
 */

import RepoHomeSection from "$lib/components/repo/RepoHomeSection.svelte";
import { commandShortcut } from "$lib/stores/commands.svelte";
import { getReposFetchAttempted, getRepositories } from "$lib/stores/repos.svelte";

const repos = $derived(getRepositories());
const resolved = $derived(getReposFetchAttempted());
</script>

{#snippet hint(commandId: string, action: string)}
	<span class="flex items-center gap-1">
		{#each commandShortcut(commandId) as glyph, i (i)}
			{#if i > 0}<span class="text-text-muted">+</span>{/if}
			<kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">{glyph}</kbd>
		{/each}
		{action}
	</span>
{/snippet}

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
			{@render hint("palette:search", "to open a pull request")}
			{@render hint("palette:commands", "to open the command palette")}
		</p>
	</div>
{/if}

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
	   stack reads as separate homepages rather than one long page. */
	.feed > :global(section + section) {
		margin-top: 56px;
		padding-top: 56px;
		border-top: 1px solid var(--color-border-subtle);
	}
</style>
