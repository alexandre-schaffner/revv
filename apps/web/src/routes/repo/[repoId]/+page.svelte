<script lang="ts">
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import RepoHomeSection from "$lib/components/repo/RepoHomeSection.svelte";
import { getSelectedRepo } from "$lib/stores/prs.svelte";

const repo = $derived(getSelectedRepo());
const repoIdFromUrl = $derived(page.params.repoId ?? "");
</script>

<AuthGuard>
	<div class="repo-scroll">
	<div class="repo-landing">
		{#if repo}
			<RepoHomeSection {repo} variant="page" />
		{:else}
			<div class="missing">
				<h1 class="missing-title">Repository not found</h1>
				<p class="missing-text">No repo matches <code>{repoIdFromUrl}</code> in your visible workspace.</p>
				<p class="missing-text">Pick another project from the rail on the left.</p>
			</div>
		{/if}
	</div>
	</div>
</AuthGuard>

<style>
	.repo-scroll {
		height: 100%;
		overflow-y: auto;
		scrollbar-width: none;
	}

	.repo-scroll::-webkit-scrollbar {
		display: none;
	}

	.repo-landing {
		display: flex;
		flex-direction: column;
		gap: 32px;
		padding: 64px 48px 48px;
		/* Wider than a reading measure because the queue table is the primary
		   content here. The recap card caps its own prose at 70ch. */
		max-width: 960px;
		margin: 0 auto;
	}

	.missing {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 48px;
		text-align: center;
	}

	.missing-title {
		font-size: 18px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0;
	}

	.missing-text {
		font-size: 13px;
		color: var(--color-text-muted);
		margin: 0;
	}

	.missing code {
		font-family: var(--font-mono, monospace);
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--color-bg-elevated);
		color: var(--color-text-secondary);
	}
</style>
