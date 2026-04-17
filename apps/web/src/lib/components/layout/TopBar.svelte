<script lang="ts">
	import { Sun, Moon, Monitor, RefreshCw } from '@lucide/svelte';
	import FloatingTabs from './FloatingTabs.svelte';
	import { getSelectedPr, getSelectedPrId } from '$lib/stores/prs.svelte';
	import { getActiveTab, setActiveTab } from '$lib/stores/review.svelte';
	import { getThemePreference, setThemePreference, type ThemePreference } from '$lib/stores/theme.svelte';
	import { getActivePanel } from '$lib/stores/focus-mode.svelte';
	import { getTopbarCollapsed } from '$lib/stores/topbar.svelte';
	import { getIsStreaming as getWalkthroughStreaming, getSummary as getWalkthroughSummary, regenerate as regenerateWalkthrough } from '$lib/stores/walkthrough.svelte';
	import { getLastSyncAt, getSyncing, getSyncError, setSyncing, setSyncError } from '$lib/stores/sync.svelte';
	import { requestThreadSync } from '$lib/stores/ws.svelte';
	import { page } from '$app/state';

	interface Props {
		rightPanelOpen: boolean;
		onTogglePanel: () => void;
	}

	let { rightPanelOpen, onTogglePanel }: Props = $props();

	const pr = $derived(getSelectedPr());
	const activeTab = $derived(getActiveTab());
	const theme = $derived(getThemePreference());
	const collapsed = $derived(getTopbarCollapsed());
	const walkthroughStreaming = $derived(getWalkthroughStreaming());
	const walkthroughSummary = $derived(getWalkthroughSummary());
	const syncing = $derived(getSyncing());
	const syncError = $derived(getSyncError());
	const lastSyncAt = $derived(getLastSyncAt());
	const selectedPrId = $derived(getSelectedPrId());
	const cycle: Record<ThemePreference, ThemePreference> = {
		system: 'light',
		light: 'dark',
		dark: 'system',
	};

	const labels: Record<ThemePreference, string> = {
		system: 'System theme',
		light: 'Light theme',
		dark: 'Dark theme',
	};

	function cycleTheme() {
		setThemePreference(cycle[theme]);
	}

	function formatSyncAge(iso: string | null): string {
		if (!iso) return '';
		const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
		if (diff < 5) return 'just now';
		if (diff < 60) return `${diff}s ago`;
		const mins = Math.floor(diff / 60);
		if (mins < 60) return `${mins}m ago`;
		return `${Math.floor(mins / 60)}h ago`;
	}

	function handleRetrySync() {
		if (selectedPrId) {
			setSyncing(true);
			setSyncError(null);
			requestThreadSync(selectedPrId);
		}
	}
</script>

<div class="topbar" data-tauri-drag-region>
	<!-- Left: app name / inline PR title when scrolled -->
	<div class="title-block">
		{#if collapsed && pr}
			<span class="inline-title"><span class="pr-number">#{pr.externalId}</span> {pr.title}</span>
		{:else if !pr}
			<span class="app-name">Revv</span>
		{/if}
	</div>

	<!-- Right: regenerate + sync indicator + theme toggle + panel toggle -->
	<div class="panel-toggle-wrap">
		{#if collapsed && activeTab === 'walkthrough' && !walkthroughStreaming && walkthroughSummary}
			<button
				class="theme-btn"
				onclick={() => regenerateWalkthrough(page.params['prId'] ?? '')}
				aria-label="Regenerate walkthrough"
				title="Regenerate walkthrough"
			>
				<RefreshCw size={14} />
			</button>
		{/if}
		{#if pr && lastSyncAt !== null}
			<div class="sync-indicator" class:sync-indicator--error={!!syncError}>
				{#if syncing}
					<span class="sync-icon sync-icon--spinning"><RefreshCw size={11} /></span>
					<span class="sync-label">Syncing…</span>
				{:else if syncError}
					<span class="sync-label sync-label--error">Sync failed</span>
					<button class="sync-retry" onclick={handleRetrySync} title="Retry sync">
						<RefreshCw size={11} />
					</button>
				{:else}
					<RefreshCw size={11} class="sync-icon" />
					<span class="sync-label">Synced {formatSyncAge(lastSyncAt)}</span>
				{/if}
			</div>
		{/if}
		<button
			class="theme-btn"
			onclick={cycleTheme}
			aria-label={labels[theme]}
			title={labels[theme]}
		>
			{#if theme === 'light'}
				<Sun size={14} />
			{:else if theme === 'dark'}
				<Moon size={14} />
			{:else}
				<Monitor size={14} />
			{/if}
		</button>

		<button
			class="panel-btn"
			class:panel-btn--open={rightPanelOpen}
			onclick={onTogglePanel}
			aria-label="Toggle context panel (⌘\)"
			title="Toggle context panel (⌘\)"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<rect width="18" height="18" x="3" y="3" rx="2" />
				<path d="M15 3v18" />
			</svg>
		</button>
	</div>
</div>

<style>
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 100%;
		padding: 0 8px;
		position: relative;
	}

	.title-block {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 1px;
		min-width: 0;
		flex: 1;
	}

	.app-name {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.inline-title {
		font-size: 12px;
		font-weight: 400;
		color: var(--color-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pr-number {
		color: var(--color-text-muted);
		font-weight: 500;
		margin-right: 4px;
	}

	.panel-toggle-wrap {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: 1;
		justify-content: flex-end;
	}

	/* In Tauri, position elements in the traffic-light zone */
	:global(html.tauri) .topbar {
		position: static;
	}

	:global(html.tauri) .panel-toggle-wrap {
		position: absolute;
		top: 4px;
		right: 8px;
		height: 22px;
		flex: none;
	}

	:global(html.tauri) .title-block {
		position: absolute;
		top: 4px;
		left: 84px;
		right: 80px;
		height: 22px;
	}

	.theme-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.theme-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.panel-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.panel-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.panel-btn--open {
		color: var(--color-tree-active-text);
		background: var(--color-tree-active-bg);
	}

	.panel-btn--open:hover {
		background: rgba(59, 130, 246, 0.12);
		color: var(--color-tree-active-text);
	}

	.sync-indicator {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 10px;
		color: var(--color-text-muted);
		padding: 0 4px;
		user-select: none;
	}
	.sync-indicator--error {
		color: var(--color-danger, #dc2626);
	}
	.sync-icon--spinning {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}
	.sync-label {
		white-space: nowrap;
	}
	.sync-label--error {
		color: var(--color-danger, #dc2626);
	}
	.sync-retry {
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: none;
		cursor: pointer;
		color: inherit;
		padding: 2px;
		border-radius: 3px;
	}
	.sync-retry:hover {
		background: var(--color-bg-tertiary);
	}
</style>
