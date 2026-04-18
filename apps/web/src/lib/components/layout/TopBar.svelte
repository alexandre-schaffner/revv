<script lang="ts">
	import { Sun, Moon, Monitor, RefreshCw } from '@lucide/svelte';

	import FloatingTabs from './FloatingTabs.svelte';
	import { getSelectedPr } from '$lib/stores/prs.svelte';
	import { getActiveTab, setActiveTab } from '$lib/stores/review.svelte';
	import { getThemePreference, setThemePreference, type ThemePreference } from '$lib/stores/theme.svelte';
	import { getActivePanel } from '$lib/stores/focus-mode.svelte';
	import { getTopbarCollapsed, getTopbarSubtitle } from '$lib/stores/topbar.svelte';
	import { getIsStreaming as getWalkthroughStreaming, getSummary as getWalkthroughSummary, regenerate as regenerateWalkthrough, getIssues as getWalkthroughIssues } from '$lib/stores/walkthrough.svelte';
	import { page } from '$app/state';
	import RegenerateDialog from '$lib/components/walkthrough/RegenerateDialog.svelte';

	interface Props {
		rightPanelOpen: boolean;
		onTogglePanel: () => void;
	}

	let { rightPanelOpen, onTogglePanel }: Props = $props();

	const pr = $derived(getSelectedPr());
	const activeTab = $derived(getActiveTab());
	const theme = $derived(getThemePreference());
	const collapsed = $derived(getTopbarCollapsed());
	const topbarSubtitle = $derived(getTopbarSubtitle());
	const walkthroughStreaming = $derived(getWalkthroughStreaming());
	const walkthroughSummary = $derived(getWalkthroughSummary());
	const walkthroughIssues = $derived(getWalkthroughIssues());
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

	let regenerateDialogOpen = $state(false);

	function handleRegenerate(): void {
		const prId = page.params['prId'] ?? '';
		if (walkthroughIssues.length > 0) {
			regenerateDialogOpen = true;
		} else {
			regenerateWalkthrough(prId);
		}
	}
</script>

<div class="topbar" data-tauri-drag-region>
	<!-- Left: app name / inline PR title when scrolled -->
	<div class="title-block" data-tauri-drag-region>
		{#if collapsed && pr}
			<span class="inline-title" data-tauri-drag-region>
				<span class="pr-number" data-tauri-drag-region>#{pr.externalId}</span>{pr.title}{#if topbarSubtitle}<span class="title-separator" data-tauri-drag-region> / </span><span class="title-subtitle" data-tauri-drag-region>{topbarSubtitle}</span>{/if}
			</span>
		{:else if !pr}
			<span class="app-name" data-tauri-drag-region>Revv</span>
		{/if}
	</div>

	<!-- Right: regenerate + sync indicator + theme toggle + panel toggle -->
	<div class="panel-toggle-wrap" data-tauri-drag-region>
		{#if collapsed && activeTab === 'walkthrough' && !walkthroughStreaming && walkthroughSummary}
			<button
				class="theme-btn"
				onclick={handleRegenerate}
				aria-label="Regenerate walkthrough"
				title="Regenerate walkthrough"
			>
				<RefreshCw size={14} />
			</button>
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

<RegenerateDialog
	bind:open={regenerateDialogOpen}
	issues={walkthroughIssues}
	onconfirm={(kept) => regenerateWalkthrough(page.params['prId'] ?? '', kept)}
	oncancel={() => {}}
/>

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
		background: var(--color-tree-active-bg);
		color: var(--color-tree-active-text);
	}

	.title-separator {
		color: var(--color-text-muted);
		opacity: 0.5;
		margin: 0 4px;
	}

	.title-subtitle {
		color: var(--color-text-muted);
		font-family: var(--font-mono, monospace);
		font-size: 11px;
	}
</style>
