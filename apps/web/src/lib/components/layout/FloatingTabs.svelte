<script lang="ts">
	type Tab = 'walkthrough' | 'diff' | 'request-changes';

	interface Props {
		activeTab: Tab;
		onTabChange: (tab: Tab) => void;
		openThreads?: number;
		pendingThreads?: number;
	}

	let { activeTab, onTabChange, openThreads = 0, pendingThreads = 0 }: Props = $props();

	const tabs: { id: Tab; label: string }[] = [
		{ id: 'walkthrough', label: 'Walkthrough' },
		{ id: 'diff', label: 'Diff' },
		{ id: 'request-changes', label: 'Request Changes' },
	];

	let segmentEls: (HTMLButtonElement | null)[] = $state(tabs.map(() => null));
	let hoveredIndex = $state<number | null>(null);
	let indicatorLeft = $state(0);
	let indicatorWidth = $state(0);
	let hasMeasured = $state(false);

	$effect(() => {
		const activeIndex = tabs.findIndex((t) => t.id === activeTab);
		const index = hoveredIndex ?? activeIndex;
		const el = segmentEls[index];
		if (!el) return;
		indicatorLeft = el.offsetLeft;
		indicatorWidth = el.offsetWidth;
		hasMeasured = true;
	});

	function showDivider(index: number): boolean {
		if (index === tabs.length - 1) return false;
		const activeIndex = tabs.findIndex((t) => t.id === activeTab);
		const highlighted = hoveredIndex ?? activeIndex;
		return index !== highlighted && index + 1 !== highlighted;
	}
</script>

<div class="tabs-wrapper">
	<div class="pill">
		<span
			class="pill-indicator"
			class:pill-indicator--ready={hasMeasured}
			style="transform: translateX({indicatorLeft}px); width: {indicatorWidth}px;"
			aria-hidden="true"
		></span>
		{#each tabs as tab, i}
			<button
				bind:this={segmentEls[i]}
				class="pill-segment"
				class:pill-segment--active={activeTab === tab.id}
				class:pill-segment--hovered={hoveredIndex === i}
				onclick={() => onTabChange(tab.id)}
				onpointerenter={() => (hoveredIndex = i)}
				onpointerleave={() => {
					if (hoveredIndex === i) hoveredIndex = null;
				}}
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
		class:mode-dot--pending={pendingThreads > 0}
		class:mode-dot--open={pendingThreads === 0 && openThreads > 0}
		class:mode-dot--visible={openThreads > 0 || pendingThreads > 0}
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

	.mode-dot--visible {
		opacity: 1;
	}

	.mode-dot--pending {
		background: #d97706;
	}

	.mode-dot--open {
		background: var(--color-accent);
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

	.pill-segment--hovered:not(.pill-segment--active) {
		color: var(--color-text-secondary);
	}

	.pill-segment--active {
		color: var(--color-text-primary);
	}

	.pill-indicator {
		position: absolute;
		top: 3px;
		left: 0;
		height: 36px;
		border-radius: 9999px;
		background: var(--color-glass-active-bg);
		box-shadow:
			0 1px 3px rgba(0, 0, 0, 0.12),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
		pointer-events: none;
		z-index: 0;
		opacity: 0;
		will-change: transform, width;
	}

	.pill-indicator--ready {
		opacity: 1;
		transition:
			transform var(--duration-smooth) var(--ease-out-expo),
			width var(--duration-smooth) var(--ease-out-expo),
			opacity var(--duration-snap);
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
