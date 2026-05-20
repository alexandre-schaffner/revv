<script lang="ts">
import GitPullRequestCreateArrow from "phosphor-svelte/lib/GitPullRequest";
import Sparkles from "phosphor-svelte/lib/Sparkle";
import type { Repository } from "@revv/shared";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";

interface Props {
  repo: Repository | null;
  onNewPr?: () => void;
}

let { repo, onNewPr }: Props = $props();

// New-PR backend lands in a follow-up. Until then the button is disabled
// with a tooltip explaining the gap, so the affordance is visible but
// non-functional.
const newPrEnabled = $derived(typeof onNewPr === "function" && repo !== null);

function handleNewPr(): void {
  if (!newPrEnabled) return;
  onNewPr?.();
}
</script>

<header class="project-header" data-active-repo={repo?.id ?? ""}>
	{#if repo}
		<div class="project-meta">
			<div class="project-title-row">
				<span class="project-name" title={repo.fullName}>{repo.name}</span>
			</div>
			<span class="project-owner" title={repo.fullName}>{repo.owner}/{repo.name}</span>
		</div>

		<div class="project-actions">
			<Tooltip.Root>
				<Tooltip.Trigger>
					<a
						class="header-link"
						href="/repo/{repo.id}/recaps"
						aria-label="Recaps for {repo.fullName}"
					>
						<Sparkles size={13} />
						<span class="header-link-label">Recaps</span>
					</a>
				</Tooltip.Trigger>
				<Tooltip.Content side="bottom" sideOffset={6}>Daily &amp; weekly recaps</Tooltip.Content>
			</Tooltip.Root>

			<Tooltip.Root>
				<Tooltip.Trigger>
					<button
						type="button"
						class="new-pr-button"
						class:new-pr-button--disabled={!newPrEnabled}
						disabled={!newPrEnabled}
						onclick={handleNewPr}
						aria-label="Start a new pull request with the agent"
					>
						<GitPullRequestCreateArrow size={13} />
						<span class="new-pr-label">New PR</span>
					</button>
				</Tooltip.Trigger>
				<Tooltip.Content side="bottom" sideOffset={6} align="end">
					{newPrEnabled
						? 'Start a new PR — chat with the agent in a worktree'
						: 'Coming soon — agent-driven PR creation'}
				</Tooltip.Content>
			</Tooltip.Root>
		</div>
	{:else}
		<div class="project-meta project-meta--placeholder">
			<span class="placeholder-title">No project selected</span>
			<span class="placeholder-hint">Pick a project from the rail.</span>
		</div>
	{/if}
</header>

<style>
	.project-header {
		display: flex;
		flex-direction: column;
		gap: var(--spacing-island);
		padding: var(--spacing-inset) var(--spacing-inset) var(--spacing-island);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
	}

	.project-meta {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.project-meta--placeholder {
		gap: 2px;
		padding: 6px 2px;
	}

	.project-title-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.project-name {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.project-owner {
		font-size: 11px;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.placeholder-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.placeholder-hint {
		font-size: 11px;
		color: var(--color-text-muted);
	}

	.project-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.header-link {
		display: inline-flex;
		align-items: center;
		gap: var(--spacing-island-half);
		padding: var(--spacing-island-half) var(--spacing-island);
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-secondary);
		font-size: 11px;
		text-decoration: none;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.header-link:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.header-link-label {
		font-weight: 500;
	}

	.new-pr-button {
		display: inline-flex;
		align-items: center;
		gap: var(--spacing-island-half);
		margin-left: auto;
		padding: 4px 10px;
		border: none;
		border-radius: 6px;
		background: var(--color-accent, var(--color-bg-elevated));
		color: var(--color-accent-foreground, var(--color-text-primary));
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
		transition: filter var(--duration-snap), background-color var(--duration-snap);
	}

	.new-pr-button:hover:not(:disabled) {
		filter: brightness(1.08);
	}

	.new-pr-button--disabled {
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
		cursor: not-allowed;
	}

	.new-pr-label {
		line-height: 1;
	}
</style>
