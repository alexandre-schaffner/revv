<script lang="ts">
import GitPullRequest from "phosphor-svelte/lib/GitPullRequest";
import StarFour from "phosphor-svelte/lib/StarFour";
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import RepoOpenIssues from "$lib/components/repo/RepoOpenIssues.svelte";
import RepoRecapCard from "$lib/components/repo/RepoRecapCard.svelte";
import RepoTaggedPrs from "$lib/components/repo/RepoTaggedPrs.svelte";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import { getSelectedRepo } from "$lib/stores/prs.svelte";

const repo = $derived(getSelectedRepo());
const repoIdFromUrl = $derived(page.params.repoId ?? "");
</script>

<AuthGuard>
	<div class="repo-scroll">
	<div class="repo-landing">
		{#if repo}
			<div class="hero">
				<RepoGradientAvatar
					fullName={repo.fullName}
					ownerAvatarUrl={repo.avatarUrl}
					size={48}
					radius={10}
					class="hero-avatar"
				/>
				<div class="hero-text">
					<h1 class="hero-title">{repo.name}</h1>
					<p class="hero-owner">{repo.owner}/{repo.name}</p>
				</div>
			</div>

			<div class="hint-row">
				<div class="hint-card hint-card--review">
					<GitPullRequest size={16} weight="fill" class="hint-icon" />
					<div class="hint-body">
						<p class="hint-title">Pick a pull request</p>
						<p class="hint-detail">Choose one from the column on the left to start reviewing.</p>
					</div>
				</div>

				<a class="hint-card hint-card--link hint-card--recaps" href="/repo/{repo.id}/recaps">
					<StarFour size={16} weight="fill" class="hint-icon" />
					<div class="hint-body">
						<p class="hint-title">Recaps</p>
						<p class="hint-detail">Daily and weekly summaries of merged work for this repo.</p>
					</div>
				</a>
			</div>

			<RepoTaggedPrs repoId={repo.id} />
			<RepoOpenIssues repoId={repo.id} />
			<RepoRecapCard repoId={repo.id} />
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
		max-width: 760px;
		margin: 0 auto;
	}

	.hero {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.hero-avatar {
		flex-shrink: 0;
	}

	.hero-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.hero-title {
		font-size: 22px;
		font-weight: 700;
		color: var(--color-text-primary);
		margin: 0;
		line-height: 1.2;
	}

	.hero-owner {
		font-size: 13px;
		color: var(--color-text-muted);
		margin: 0;
		font-family: var(--font-mono, monospace);
	}

	.hint-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 12px;
	}

	.hint-card {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		padding: 14px 16px;
		border: 1px solid var(--color-border);
		border-radius: 10px;
		background: var(--color-bg-secondary);
		text-decoration: none;
		color: inherit;
	}

	.hint-card--link:hover {
		border-color: var(--color-border-focus, var(--color-accent));
		background: var(--color-bg-elevated);
	}

	.hint-card--recaps :global(.hint-icon) {
		color: var(--color-warning);
	}

	.hint-card--review :global(.hint-icon) {
		color: var(--revv-accent);
	}

	:global(.hint-icon) {
		color: var(--color-text-secondary);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.hint-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.hint-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0;
	}

	.hint-detail {
		font-size: 12px;
		color: var(--color-text-muted);
		margin: 0;
		line-height: 1.45;
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
