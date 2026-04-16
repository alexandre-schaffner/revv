<script lang="ts">
	import { Sun, Moon, Monitor } from '@lucide/svelte';
	import FloatingTabs from './FloatingTabs.svelte';
	import { getSelectedPr } from '$lib/stores/prs.svelte';
	import { getActiveTab, setActiveTab } from '$lib/stores/review.svelte';
	import { getThemePreference, setThemePreference, type ThemePreference } from '$lib/stores/theme.svelte';
	import { getActivePanel } from '$lib/stores/focus-mode.svelte';

	interface Props {
		rightPanelOpen: boolean;
		onTogglePanel: () => void;
	}

	let { rightPanelOpen, onTogglePanel }: Props = $props();

	const pr = $derived(getSelectedPr());
	const activeTab = $derived(getActiveTab());
	const theme = $derived(getThemePreference());

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
</script>

<div class="topbar">
	<!-- Left: PR title block or app name -->
	<div class="title-block">
		{#if pr}
			<span class="pr-title">{pr.title}</span>
			<span class="pr-subtitle">#{pr.externalId} · {pr.sourceBranch} → {pr.targetBranch}</span>
		{:else}
			<span class="app-name">Rev</span>
		{/if}
	</div>

	<!-- Right: theme toggle + panel toggle -->
	<div class="panel-toggle-wrap">
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
		padding: 0 16px;
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
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.pr-title {
		font-size: 16px;
		font-weight: 700;
		color: var(--color-text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		line-height: 1.3;
	}

	.pr-subtitle {
		font-size: 11px;
		font-family: var(--font-mono);
		color: var(--color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		opacity: 0.6;
		line-height: 1.3;
	}

	.panel-toggle-wrap {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: 1;
		justify-content: flex-end;
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
</style>
