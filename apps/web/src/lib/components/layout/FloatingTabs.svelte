<script lang="ts">
	import { DownloadCloud, Loader2 } from '@lucide/svelte';

	type Tab = 'walkthrough' | 'diff' | 'request-changes';
	type WalkthroughStatus = 'idle' | 'generating' | 'complete' | 'error';

	interface Props {
		activeTab: Tab;
		onTabChange: (tab: Tab) => void;
		walkthroughStatus?: WalkthroughStatus;
		/**
		 * True when the PR the user is viewing has a newer headSha than the
		 * diff currently rendered — signals "pull this commit to refresh".
		 */
		hasNewCommit?: boolean;
		/** True while the pull is in-flight (refetching + regenerating). */
		isPulling?: boolean;
		onPullCommit?: () => void;
	}

	let {
		activeTab,
		onTabChange,
		walkthroughStatus = 'idle',
		hasNewCommit = false,
		isPulling = false,
		onPullCommit,
	}: Props = $props();

	// The dot and the pull button live in the same slot to the right of the
	// pill tabs. Only one is visible at a time — the pull affordance takes
	// precedence because it requires user action; walkthrough status is
	// passive info. Both elements stay in the DOM so opacity + scale
	// transitions run on mount/unmount of visibility, producing a clean
	// crossfade rather than a layout-shifting morph.
	const dotVisible = $derived(!hasNewCommit && walkthroughStatus !== 'idle');
	const buttonVisible = $derived(hasNewCommit);
	const buttonInteractive = $derived(hasNewCommit && !isPulling);

	function handlePullClick(): void {
		if (buttonInteractive) onPullCommit?.();
	}

	const tabs: { id: Tab; label: string }[] = [
		{ id: 'walkthrough', label: 'Walkthrough' },
		{ id: 'diff', label: 'Diff' },
		{ id: 'request-changes', label: 'Request Changes' },
	];

	let pillEl: HTMLDivElement | null = $state(null);
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

		const measure = () => {
			if (!pillEl || !el) return;
			const pillRect = pillEl.getBoundingClientRect();
			const segRect = el.getBoundingClientRect();
			// .pill has border: 1px + padding: 3px. getBoundingClientRect()
			// returns border-box coords; .pill-indicator { left: 0 } measures
			// from the padding edge per CSS spec, so subtract border-left
			// to keep the two reference frames aligned.
			const borderLeft = parseFloat(getComputedStyle(pillEl).borderLeftWidth) || 0;
			// Snap BOTH edges to integer device pixels. Fractional segment
			// widths accumulate across flex siblings, so segment[0] has an
			// integer left edge but fractional right edge while segment[2]
			// has fractional values on both sides. That sub-pixel phase
			// difference produces per-tab anti-aliasing asymmetry that reads
			// as "padding looks different on different tabs." Rounding both
			// edges equalizes the rendering; rounding both (vs. rounding
			// left + width independently) preserves the segment's true
			// center so the label stays visually centered in the indicator.
			const rawLeft = segRect.left - pillRect.left - borderLeft;
			const rawRight = rawLeft + segRect.width;
			const snappedLeft = Math.round(rawLeft);
			const snappedRight = Math.round(rawRight);
			indicatorLeft = snappedLeft;
			indicatorWidth = snappedRight - snappedLeft;
			hasMeasured = true;
		};

		measure();

		// Re-measure when any segment's size changes (e.g., web font swap
		// from system-ui to Inter). Observing every segment catches sibling
		// resizes that shift the active segment's position. Also observe the
		// pill itself to catch parent-driven reflow that shifts segment origin.
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
			>{tab.label}</button>
			{#if i < tabs.length - 1}
				<span
					class="pill-divider"
					class:pill-divider--hidden={isDividerHidden(i)}
					aria-hidden="true"
				></span>
			{/if}
		{/each}
	</div>

	<div class="status-slot" aria-hidden={!dotVisible && !buttonVisible}>
		<span
			class="status-dot"
			class:status-dot--visible={dotVisible}
			class:status-dot--generating={walkthroughStatus === 'generating'}
			class:status-dot--complete={walkthroughStatus === 'complete'}
			class:status-dot--error={walkthroughStatus === 'error'}
			aria-hidden="true"
		></span>

		<button
			type="button"
			class="pull-btn"
			class:pull-btn--visible={buttonVisible}
			class:pull-btn--pulling={isPulling}
			disabled={!buttonInteractive}
			tabindex={buttonVisible && !isPulling ? 0 : -1}
			aria-hidden={!buttonVisible}
			onclick={handlePullClick}
			title={isPulling ? 'Pulling new commit…' : 'New commit — click to pull and refresh'}
			aria-label={isPulling
				? 'Pulling new commit'
				: 'New commit available. Click to pull and regenerate walkthrough.'}
		>
			{#if isPulling}
				<Loader2 size={12} class="animate-spin" />
			{:else}
				<DownloadCloud size={12} />
			{/if}
			<span class="pull-btn-label">Pull</span>
		</button>
	</div>
</div>

<style>
	.tabs-wrapper {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	/*
	 * Status slot — anchored to the right of the pill. Holds two stacked
	 * children (the walkthrough-status dot and the pull button). The slot
	 * is `position: absolute` so it never pushes the centered tabs wrapper
	 * leftward when the button appears.
	 *
	 * The two children are also `position: absolute` with `left: 0`, so
	 * they occupy the same anchor and crossfade via opacity + scale.
	 * Only one is visible at a time; the other sits invisible and
	 * non-interactive underneath.
	 */
	.status-slot {
		position: absolute;
		left: calc(100% + 8px);
		top: 50%;
		/* Height matches the tallest child (the 18 px button) so the
		 * slot's center line — which both children align to — stays fixed
		 * regardless of which one is currently visible. */
		height: 18px;
		transform: translateY(-50%);
		pointer-events: none;
	}

	/* ── Walkthrough status dot (6 × 6, centered in the slot) ── */
	.status-dot {
		position: absolute;
		left: 0;
		top: 50%;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: transparent;
		opacity: 0;
		transform: translateY(-50%) scale(0.6);
		transform-origin: left center;
		/* Decorative only — never interactive, even when visible. */
		pointer-events: none;
		cursor: default;
		transition:
			opacity 220ms var(--ease-out-expo),
			transform 220ms var(--ease-out-expo),
			background-color var(--duration-snap);
	}

	.status-dot--visible {
		opacity: 1;
		transform: translateY(-50%) scale(1);
	}

	.status-dot--generating {
		background: var(--color-accent);
	}

	.status-dot--visible.status-dot--generating {
		animation: status-dot-pulse 1.4s ease-in-out infinite;
	}

	.status-dot--complete {
		background: var(--color-success);
	}

	.status-dot--error {
		background: var(--color-danger);
	}

	@keyframes status-dot-pulse {
		0%, 100% { opacity: 1; }
		50%      { opacity: 0.45; }
	}

	/* ── Pull button (amber pill, 18 px tall, auto width) ──
	 * Invisible state: pointer-events: none AND cursor: default. The cursor
	 * declaration is important — `pointer-events: none` alone prevents clicks
	 * but some browsers still reflect the button's native cursor on hover,
	 * which would wrongly flip the cursor to pointer over the dot's bounds
	 * (the invisible button sits right on top of the visible dot). */
	.pull-btn {
		position: absolute;
		left: 0;
		top: 0;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 18px;
		padding: 0 10px 0 8px;
		border: none;
		border-radius: 9999px;
		background: var(--color-warning);
		color: #fff;
		font-family: inherit;
		font-size: 11px;
		font-weight: 500;
		line-height: 1;
		letter-spacing: -0.01em;
		white-space: nowrap;
		cursor: default;
		box-shadow: 0 1px 2px color-mix(in srgb, var(--color-warning) 40%, transparent);
		opacity: 0;
		transform: scale(0.85);
		transform-origin: left center;
		pointer-events: none;
		transition:
			opacity 220ms var(--ease-out-expo),
			transform 220ms var(--ease-out-expo),
			background-color var(--duration-snap);
		-webkit-font-smoothing: antialiased;
	}

	.pull-btn--visible {
		opacity: 1;
		transform: scale(1);
		pointer-events: auto;
		cursor: pointer;
	}

	.pull-btn--visible.pull-btn--pulling {
		cursor: progress;
	}

	.pull-btn--visible:not(.pull-btn--pulling):hover {
		background: color-mix(in srgb, var(--color-warning) 88%, black);
	}

	.pull-btn:focus-visible {
		outline: 2px solid var(--color-warning);
		outline-offset: 2px;
	}

	.pull-btn-label {
		line-height: 1;
	}

	@media (prefers-reduced-motion: reduce) {
		.status-dot,
		.pull-btn {
			transition-duration: 0ms;
		}
		.status-dot--visible.status-dot--generating {
			animation: none;
		}
	}

	.pill {
		position: relative;
		display: flex;
		align-items: center;
		background: var(--color-tab-track-bg);
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
</style>
