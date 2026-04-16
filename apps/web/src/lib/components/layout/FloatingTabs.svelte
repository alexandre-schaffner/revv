<script lang="ts">
	import type { FocusPanel } from '$lib/stores/focus-mode.svelte';

	type Tab = 'walkthrough' | 'diff' | 'request-changes';

	interface Props {
		activeTab: Tab;
		onTabChange: (tab: Tab) => void;
		mode?: FocusPanel;
	}

	let { activeTab, onTabChange, mode = 'sidebar' }: Props = $props();

	const tabs: { id: Tab; label: string }[] = [
		{ id: 'walkthrough', label: 'Walkthrough' },
		{ id: 'diff', label: 'Diff' },
		{ id: 'request-changes', label: 'Request Changes' },
	];

	function showDivider(index: number): boolean {
		if (index === tabs.length - 1) return false;
		const currentActive = tabs[index]?.id === activeTab;
		const nextActive = tabs[index + 1]?.id === activeTab;
		return !currentActive && !nextActive;
	}
</script>

<div class="tabs-wrapper">
	<div class="pill">
		{#each tabs as tab, i}
			<button
				class="pill-segment"
				class:pill-segment--active={activeTab === tab.id}
				onclick={() => onTabChange(tab.id)}
			>
				{tab.label}
			</button>
			{#if showDivider(i)}
				<span class="pill-divider" aria-hidden="true"></span>
			{/if}
		{/each}
	</div>

	<span
		class="mode-dot"
		class:mode-dot--scroll={mode === 'diff-scroll' || mode === 'diff-line' || mode === 'diff-visual'}
		aria-hidden="true"
	></span>
</div>

<style>
	.tabs-wrapper {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.mode-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: transparent;
		opacity: 0;
		transition:
			opacity var(--duration-snap),
			background-color var(--duration-snap);
		flex-shrink: 0;
	}

	.mode-dot--scroll {
		background: var(--color-accent);
		opacity: 1;
	}

	.pill {
		position: relative;
		display: flex;
		align-items: center;
		background: var(--color-glass-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		border-radius: 9999px;
		padding: 3px;
		box-shadow:
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
		transform: translateZ(0);
		isolation: isolate;
	}

	/* Grain noise overlay */
	.pill::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
		background-size: 128px 128px;
		opacity: var(--color-glass-grain-opacity);
		pointer-events: none;
		mix-blend-mode: overlay;
		z-index: 0;
	}

	.pill-segment {
		position: relative;
		z-index: 1;
		height: 36px;
		padding: 0 20px;
		border-radius: 9999px;
		font-size: 13px;
		font-weight: 500;
		letter-spacing: -0.01em;
		color: var(--color-tab-inactive-text);
		background: transparent;
		border: none;
		cursor: pointer;
		transition:
			color var(--duration-snap),
			background-color var(--duration-snap),
			box-shadow var(--duration-snap);
		user-select: none;
		white-space: nowrap;
		-webkit-font-smoothing: antialiased;
	}

	.pill-segment:hover:not(.pill-segment--active) {
		color: var(--color-text-secondary);
		background: var(--color-glass-highlight);
	}

	.pill-segment--active {
		color: var(--color-text-primary);
		background: var(--color-glass-active-bg);
		box-shadow:
			0 1px 3px rgba(0, 0, 0, 0.12),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
	}

	.pill-divider {
		position: relative;
		z-index: 1;
		width: 1px;
		height: 14px;
		background: var(--color-glass-border);
		flex-shrink: 0;
	}
</style>
