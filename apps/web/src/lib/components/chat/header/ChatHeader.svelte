<script lang="ts">
import type { PullRequest } from "@revv/shared";
import ArrowLeft from "phosphor-svelte/lib/ArrowLeft";
import Eraser from "phosphor-svelte/lib/Eraser";
import X from "phosphor-svelte/lib/X";
import { isWorktreeOpRunning } from "$lib/chat/proposed.svelte";
import { clearChatHistory } from "$lib/chat/turn.svelte";
import PushPill from "./PushPill.svelte";

interface Props {
  prId: string;
  /** The PR the panel belongs to, named in the header while it covers the PR. */
  pr: PullRequest | null;
  commitCount: number;
  hasItems: boolean;
  stacked: boolean;
  onClose: () => void;
}

let { prId, pr, commitCount, hasItems, stacked, onClose }: Props = $props();
</script>

<div class="panel-header" class:panel-header--stacked={stacked} data-glass>
	{#if stacked}
		<!-- Covering the main pane, the panel is the view: a back button at the
			 head of the row instead of a close button at the end. -->
		<button class="back-btn" onclick={onClose} aria-label="Back to pull request">
			<ArrowLeft size={14} />
		</button>
	{/if}
	<span class="panel-title">Chat</span>
	{#if stacked && pr}
		<span class="panel-subtitle">#{pr.externalId} {pr.title}</span>
	{/if}
	<div class="header-actions">
		{#if commitCount > 0}
			<PushPill {prId} {commitCount} sourceBranch={pr?.sourceBranch} />
		{/if}
		{#if hasItems}
			<button
				class="icon-btn"
				onclick={() => clearChatHistory(prId)}
				title={commitCount > 0
					? `Clear conversation and discard ${commitCount} proposed commit${commitCount === 1 ? '' : 's'}`
					: 'Clear conversation'}
				aria-label={commitCount > 0
					? 'Clear conversation and discard proposed commits'
					: 'Clear conversation'}
				disabled={isWorktreeOpRunning(prId)}
			>
				<Eraser size={13} />
			</button>
		{/if}
		{#if !stacked}
			<button class="icon-btn" onclick={onClose} aria-label="Close panel">
				<X size={14} />
			</button>
		{/if}
	</div>
</div>

<style>
	.panel-header {
		height: 40px;
		border-bottom: 1px solid var(--color-border-subtle);
		padding: 0 8px 0 12px;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
		position: sticky;
		top: 0;
		z-index: 5;
		background: var(--color-panel-header-bg);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
	}

	.panel-header--stacked {
		padding-left: 6px;
	}

	.panel-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-muted);
		/* The PR subtitle beside it absorbs the squeeze instead. */
		flex-shrink: 0;
	}

	.panel-subtitle {
		font-size: 11px;
		color: var(--color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 2px;
		margin-left: auto;
		padding-left: 8px;
	}

	.back-btn,
	.icon-btn {
		width: 24px;
		height: 24px;
		border-radius: 4px;
		border: none;
		background: transparent;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.back-btn {
		color: var(--color-text-secondary);
		flex-shrink: 0;
	}

	.back-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.icon-btn {
		color: var(--color-text-muted);
	}

	.icon-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.icon-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
</style>
