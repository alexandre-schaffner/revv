<script lang="ts">
	import { tick } from 'svelte';
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

	let containerEl: HTMLDivElement;
	let tabEls: Record<Tab, HTMLButtonElement | null> = $state({
		walkthrough: null,
		diff: null,
		'request-changes': null,
	});

	let indicatorStyle = $state('');

	async function updateIndicator(tab: Tab) {
		await tick();
		const container = containerEl;
		const activeEl = tabEls[tab];
		if (!container || !activeEl) return;

		const containerRect = container.getBoundingClientRect();
		const activeRect = activeEl.getBoundingClientRect();

		const left = activeRect.left - containerRect.left - 2; // -2 for container padding
		const width = activeRect.width;
		indicatorStyle = `transform: translateX(${left}px); width: ${width}px;`;
	}

	$effect(() => {
		updateIndicator(activeTab);
	});
</script>

<div class="tabs-wrapper">
	<div class="tabs-container" bind:this={containerEl}>
		<!-- Sliding indicator -->
		<span class="tab-indicator" style={indicatorStyle} aria-hidden="true"></span>

		{#each tabs as tab}
			<button
				class="tab-btn"
				class:tab-active={activeTab === tab.id}
				bind:this={tabEls[tab.id]}
				onclick={() => onTabChange(tab.id)}
			>
				{tab.label}
			</button>
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

	.tabs-container {
		position: relative;
		display: flex;
		align-items: center;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 2px;
	}

	.tab-indicator {
		position: absolute;
		top: 2px;
		left: 0;
		height: calc(100% - 4px);
		background: var(--color-tab-active-bg);
		border-radius: 6px;
		box-shadow:
			0 1px 3px rgba(0, 0, 0, 0.5),
			inset 0 1px 0 rgba(255, 255, 255, 0.04);
		transition:
			transform var(--duration-snap) var(--ease-out-expo),
			width var(--duration-snap) var(--ease-out-expo);
		pointer-events: none;
		z-index: 0;
	}

	.tab-btn {
		position: relative;
		z-index: 1;
		height: 28px;
		padding: 0 12px;
		border-radius: 6px;
		font-size: 12px;
		font-weight: 500;
		letter-spacing: -0.01em;
		color: var(--color-tab-inactive-text);
		background: transparent;
		border: none;
		cursor: pointer;
		transition: color var(--duration-snap);
		user-select: none;
		white-space: nowrap;
	}

	.tab-btn:hover {
		color: var(--color-text-secondary);
	}

	.tab-active {
		color: var(--color-text-primary) !important;
	}
</style>
