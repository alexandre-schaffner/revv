<script lang="ts">
import type { Snippet } from "svelte";

export type TabConfig = { id: string; label: string; shortcut?: string };

interface Props {
  tabs: TabConfig[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  trailing?: Snippet;
  cmdHeld?: boolean;
}

let { tabs, activeTab, onTabChange, trailing, cmdHeld = false }: Props = $props();

let pillEl: HTMLDivElement | null = $state(null);
let segmentEls = $state<(HTMLButtonElement | null)[]>([]);
let hoveredIndex = $state<number | null>(null);
let indicatorLeft = $state(0);
let indicatorWidth = $state(0);
let hasMeasured = $state(false);

$effect(() => {
  // Keep segment refs array length in sync with tabs prop.
  if (segmentEls.length !== tabs.length) {
    segmentEls = tabs.map((_, i) => segmentEls[i] ?? null);
  }
});

$effect(() => {
  const activeIndex = tabs.findIndex((t) => t.id === activeTab);
  const index = hoveredIndex ?? activeIndex;
  const el = segmentEls[index];
  if (!el) return;

  const measure = () => {
    const seg = el;
    if (!pillEl || !seg) return;
    const pillRect = pillEl.getBoundingClientRect();
    const segRect = seg.getBoundingClientRect();
    const borderLeft = parseFloat(getComputedStyle(pillEl).borderLeftWidth) || 0;
    const rawLeft = segRect.left - pillRect.left - borderLeft;
    const rawRight = rawLeft + segRect.width;
    const snappedLeft = Math.round(rawLeft);
    const snappedRight = Math.round(rawRight);
    indicatorLeft = snappedLeft;
    indicatorWidth = snappedRight - snappedLeft;
    hasMeasured = true;
  };

  measure();

  const observer = new ResizeObserver(measure);
  for (const s of segmentEls) {
    if (s) observer.observe(s);
  }
  if (pillEl) observer.observe(pillEl);
  return () => observer.disconnect();
});

function isDividerHidden(index: number): boolean {
  const activeIndex = tabs.findIndex((t) => t.id === activeTab);
  const highlighted = hoveredIndex ?? activeIndex;
  return index === highlighted || index + 1 === highlighted;
}
</script>

<div class="tabs-wrapper">
	<div class="pill" bind:this={pillEl}>
		<span
			class="pill-indicator"
			class:pill-indicator--ready={hasMeasured}
			style="transform: translateX({indicatorLeft}px); width: {indicatorWidth}px;"
			aria-hidden="true"
		></span>
		{#each tabs as tab, i (tab.id)}
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
>{#if tab.shortcut}<span class="seg-shortcut" class:seg-shortcut--visible={cmdHeld}>⌘{tab.shortcut}</span>{/if}<span class="seg-label">{tab.label}</span></button>
			{#if i < tabs.length - 1}
				<span
					class="pill-divider"
					class:pill-divider--hidden={isDividerHidden(i)}
					aria-hidden="true"
				></span>
			{/if}
		{/each}
	</div>

	{#if trailing}
		<div class="status-slot">
			{@render trailing()}
		</div>
	{/if}
</div>

<style>
	.tabs-wrapper {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.status-slot {
		position: absolute;
		left: calc(100% + 8px);
		top: 50%;
		height: 18px;
		transform: translateY(-50%);
		pointer-events: none;
	}

	.pill {
		position: relative;
		display: flex;
		align-items: center;
		background: var(--color-tab-track-bg);
		backdrop-filter: blur(10px) saturate(1.4);
		-webkit-backdrop-filter: blur(10px) saturate(1.4);
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
		display: inline-flex;
		align-items: center;
		justify-content: center;
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
		background: var(--color-tab-active-bg);
		box-shadow:
			var(--color-shadow-indicator),
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
		transition: opacity var(--duration-snap);
	}

	.pill-divider--hidden {
		opacity: 0;
	}

	.seg-shortcut {
		display: inline-block;
		font-size: 11px;
		font-weight: 400;
		font-variant-numeric: tabular-nums;
		color: var(--color-tab-inactive-text);
		opacity: 0;
		max-width: 0;
		overflow: hidden;
		transition:
			opacity var(--duration-snap),
			max-width var(--duration-snap),
			margin-left var(--duration-snap);
	}

	.seg-shortcut--visible {
		opacity: 0.45;
		max-width: 22px;
		margin-right: 5px;
	}

	@media (prefers-reduced-motion: reduce) {
		.pill-indicator--ready {
			transition-duration: 0ms;
		}
	}
</style>
