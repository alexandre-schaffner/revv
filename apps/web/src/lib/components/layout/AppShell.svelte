<script lang="ts">
	import Sidebar from './Sidebar.svelte';
	import TopBar from './TopBar.svelte';
	import RightPanel from './RightPanel.svelte';
	import BottomBar from './BottomBar.svelte';
	import CommandPalette from './CommandPalette.svelte';
	import FloatingTabs from './FloatingTabs.svelte';
	import { getSelectedPr } from '$lib/stores/prs.svelte';
	import {
		getPrWalkthroughStatus,
		getIsStreaming as getWalkthroughStreaming,
		getSummary as getWalkthroughSummary,
		getRatings as getWalkthroughRatings,
		getCanResume as getWalkthroughCanResume,
		regenerate as regenerateWalkthrough,
		resume as resumeWalkthrough,
		abort as abortWalkthrough,
	} from '$lib/stores/walkthrough.svelte';
	import {
		scrollToTop as scrollWalkthroughToTop,
		scrollToBottom as scrollWalkthroughToBottom,
		scrollToRatings as scrollWalkthroughToRatings,
		getUserScrolledUp as getWalkthroughUserScrolledUp,
		getHasNewContentBelow as getWalkthroughHasNewContentBelow,
	} from '$lib/stores/walkthroughNav.svelte';
	import { ArrowDown, ArrowUp, Check, Gauge, Play, RefreshCw, Sparkles, Square } from '@lucide/svelte';
	import {
		getActiveTab,
		setActiveTab,
		getPanelOpenRequested,
		consumePanelOpenRequest,
		getLoadedHeadSha,
		getIsPullingCommit,
		pullLatestCommit,
	} from '$lib/stores/review.svelte';
	import {
		getSidebarCollapsed,
		toggleSidebar,
		getRightPanelOpen,
		setRightPanelOpen,
		toggleRightPanel,
		getSidebarWidth,
		setSidebarWidth,
		resetSidebarWidth,
		SIDEBAR_WIDTH_MIN,
		SIDEBAR_WIDTH_MAX,
	} from '$lib/stores/sidebar.svelte';
	import {
		getPaletteOpen,
		getPaletteMode,
		closePalette,
	} from '$lib/stores/shortcuts.svelte';
	import {
		getRcSubmitting,
		getRcSelectedCount,
		getRcHasContent,
		getRcApproveBlockerSummary,
		getRcOnGenerateChanges,
		getRcOnSubmitReview,
		getRcOnApprove,
	} from '$lib/stores/rcActions.svelte';
	import { page } from '$app/state';

	let { children } = $props();

	const sidebarCollapsed = $derived(getSidebarCollapsed());
	const rightPanelOpen = $derived(getRightPanelOpen());
	const paletteOpen = $derived(getPaletteOpen());
	const paletteMode = $derived(getPaletteMode());
	const sidebarWidth = $derived(getSidebarWidth());
	const pr = $derived(getSelectedPr());
	const walkthroughStatus = $derived(pr ? getPrWalkthroughStatus(pr.id) : 'idle');
	const activeTab = $derived(getActiveTab());
	const isSettingsRoute = $derived(page.url.pathname.startsWith('/settings'));
	const walkthroughStreaming = $derived(getWalkthroughStreaming());
	const walkthroughSummary = $derived(getWalkthroughSummary());
	const walkthroughCanResume = $derived(getWalkthroughCanResume());
	const walkthroughHasRatings = $derived(getWalkthroughRatings().length > 0);
	const walkthroughUserScrolledUp = $derived(getWalkthroughUserScrolledUp());
	const walkthroughHasNewContentBelow = $derived(getWalkthroughHasNewContentBelow());
	const walkthroughHasContent = $derived(
		walkthroughStreaming ||
			!!walkthroughSummary ||
			walkthroughCanResume ||
			walkthroughHasRatings,
	);
	const showFloatingActions = $derived(
		!!pr && !isSettingsRoute && activeTab === 'walkthrough' && walkthroughHasContent,
	);
	const showRcActions = $derived(!!pr && !isSettingsRoute && activeTab === 'request-changes');

	const rcSubmitting = $derived(getRcSubmitting());
	const rcSelectedCount = $derived(getRcSelectedCount());
	const rcHasContent = $derived(getRcHasContent());
	const rcApproveBlockerSummary = $derived(getRcApproveBlockerSummary());

	// New-commit-available signal: the PR's current headSha differs from the
	// SHA the diff was loaded against. `getLoadedHeadSha` returns null until the
	// first successful fetch, suppressing the signal on fresh visits.
	const hasNewCommit = $derived.by(() => {
		if (!pr || !pr.headSha) return false;
		const loaded = getLoadedHeadSha(pr.id);
		return loaded !== null && loaded !== pr.headSha;
	});
	const isPulling = $derived(pr ? getIsPullingCommit(pr.id) : false);
	function onPullCommit(): void {
		if (pr) void pullLatestCommit(pr.id);
	}

	// Drag state — not reactive $state, just local mutable refs
	let isDragging = $state(false);
	let dragStartX = 0;
	let dragStartWidth = 0;

	// Auto-open panel when explain is triggered from the review store
	$effect(() => {
		if (getPanelOpenRequested()) {
			setRightPanelOpen(true);
			consumePanelOpenRequest();
		}
	});

	// Inline style for the grid — drives the dynamic sidebar column width.
	// The right pane is NOT a grid column: it's positioned absolutely on
	// top of the main row so opening it does not shrink the main column.
	// This is what keeps the walkthrough/page-title/Request Changes content
	// render byte-identical when the right pane toggles — matching the
	// user's expectation that "the right pane should behave exactly like
	// the left pane: it does not change the main content display." See
	// `.rightpanel-area` below for the overlay positioning rationale.
	const gridStyle = $derived(
		sidebarCollapsed
			? `grid-template-columns: 40px 1fr`
			: `grid-template-columns: ${sidebarWidth}px 1fr`,
	);

	function onHandlePointerDown(event: PointerEvent): void {
		if (sidebarCollapsed) return;
		event.preventDefault();
		isDragging = true;
		dragStartX = event.clientX;
		dragStartWidth = sidebarWidth;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onHandlePointerMove(event: PointerEvent): void {
		if (!isDragging) return;
		const delta = event.clientX - dragStartX;
		const newWidth = Math.max(
			SIDEBAR_WIDTH_MIN,
			Math.min(SIDEBAR_WIDTH_MAX, dragStartWidth + delta),
		);
		setSidebarWidth(newWidth);
	}

	function onHandlePointerUp(event: PointerEvent): void {
		if (!isDragging) return;
		isDragging = false;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
	}

	function onHandleDblClick(): void {
		resetSidebarWidth();
	}

</script>

<div
	class="app-shell"
	class:sidebar-collapsed={sidebarCollapsed}
	class:is-resizing={isDragging}
	style={gridStyle}
>
	<aside class="sidebar-area">
		<Sidebar collapsed={sidebarCollapsed} />

		{#if !sidebarCollapsed}
			<div
				class="resize-handle"
				role="separator"
				aria-label="Resize sidebar"
				aria-orientation="vertical"
				tabindex="-1"
				onpointerdown={onHandlePointerDown}
				onpointermove={onHandlePointerMove}
				onpointerup={onHandlePointerUp}
				ondblclick={onHandleDblClick}
			></div>
		{/if}
	</aside>

	<header class="topbar-area" data-tauri-drag-region>
		<TopBar
			{rightPanelOpen}
			onTogglePanel={toggleRightPanel}
			{sidebarCollapsed}
			onToggleSidebar={toggleSidebar}
		/>
		{#if pr && !isSettingsRoute}
			<div class="tabs-float">
				<FloatingTabs
					{activeTab}
					onTabChange={setActiveTab}
					{walkthroughStatus}
					{hasNewCommit}
					{isPulling}
					{onPullCommit}
				/>
			</div>
		{/if}
	</header>

	<main class="main-area">
		{@render children()}
	</main>

	<footer class="bottombar-area">
		<BottomBar />
	</footer>

	{#if showFloatingActions && activeTab === 'walkthrough'}
		<div class="walkthrough-actions-float">
			<div class="walkthrough-actions-row">
				{#if walkthroughStreaming}
					<button
						type="button"
						class="walkthrough-action-btn walkthrough-action-btn--danger"
						onclick={abortWalkthrough}
					>
						<Square size={14} fill="currentColor" />
						Stop generation
					</button>
					{#if walkthroughHasNewContentBelow}
						<button
							type="button"
							class="walkthrough-action-btn"
							onclick={scrollWalkthroughToBottom}
							aria-label="Scroll to newest walkthrough content"
						>
							<ArrowDown size={14} />
							New content
						</button>
					{/if}
				{:else}
					{#if walkthroughCanResume && pr}
						<button
							type="button"
							class="walkthrough-action-btn"
							onclick={() => resumeWalkthrough(pr.id)}
						>
							<Play size={14} fill="currentColor" />
							Resume
						</button>
					{/if}
					{#if walkthroughSummary && pr}
						<button
							type="button"
							class="walkthrough-action-btn"
							onclick={() => regenerateWalkthrough(pr.id)}
						>
							<RefreshCw size={14} />
							Regenerate
						</button>
					{/if}
				{/if}

				<button
					type="button"
					class="walkthrough-action-btn"
					onclick={scrollWalkthroughToTop}
					aria-label="Scroll to top of walkthrough"
				>
					<ArrowUp size={14} />
					Top
				</button>

				{#if walkthroughHasRatings}
					<button
						type="button"
						class="walkthrough-action-btn"
						onclick={scrollWalkthroughToRatings}
						aria-label="Scroll to rating panel"
					>
						<Gauge size={14} />
						Rating
					</button>
				{/if}
			</div>
		</div>
	{/if}

	{#if showRcActions && activeTab === 'request-changes'}
		<div class="walkthrough-actions-float">
			<div class="walkthrough-actions-row">
				<button
					type="button"
					class="walkthrough-action-btn walkthrough-action-btn--muted"
					disabled={rcSubmitting !== null || rcSelectedCount === 0}
					onclick={() => getRcOnGenerateChanges()()}
					title={rcSelectedCount === 0
						? 'Select at least one issue to ask the agent to address'
						: 'Open the chat panel and ask the agent to address the selected issues as commits'}
				>
					<Sparkles size={14} />
					Generate changes
				</button>
				<button
					type="button"
					class="walkthrough-action-btn walkthrough-action-btn--accent"
					disabled={rcSubmitting !== null || !rcHasContent}
					onclick={() => getRcOnSubmitReview()()}
					title={!rcHasContent
						? 'Add comments or select walkthrough issues first'
						: 'Request changes on this pull request'}
				>
					<ArrowUp size={14} />
					{rcSubmitting === 'request_changes' ? 'Submitting…' : 'Submit Review'}
				</button>
				<button
					type="button"
					class="walkthrough-action-btn walkthrough-action-btn--success"
					disabled={rcSubmitting !== null}
					onclick={() => getRcOnApprove()()}
					title={rcApproveBlockerSummary
						? `Approve this pull request — ${rcApproveBlockerSummary} still open`
						: 'Approve this pull request on GitHub'}
				>
					<Check size={14} />
					{rcSubmitting === 'approve' ? 'Approving…' : 'Approve'}
				</button>
			</div>
		</div>
	{/if}

	<aside
		class="rightpanel-area"
		class:rightpanel-area--open={rightPanelOpen}
		aria-hidden={!rightPanelOpen}
	>
		<RightPanel onClose={toggleRightPanel} prId={page.params['prId'] ?? ''} />
	</aside>
</div>

<CommandPalette open={paletteOpen} mode={paletteMode} onClose={closePalette} />

<style>
	.app-shell {
		display: grid;
		grid-template-rows: auto 1fr 40px;
		grid-template-areas:
			'topbar  topbar'
			'sidebar main'
			'sidebar bottombar';
		height: 100vh;
		width: 100vw;
		overflow: hidden;
		/* Positioning context for the absolutely-positioned right pane. */
		position: relative;
		background-color: var(--color-bg-primary);
		transition:
			grid-template-columns 100ms var(--ease-out-expo),
			grid-template-rows 100ms var(--ease-out-expo);
	}

	/* Suppress the column transition while dragging so resize feels instant */
	.app-shell.is-resizing {
		transition: none;
	}

	/* ── Sidebar area ── */
	.sidebar-area {
		grid-area: sidebar;
		position: relative;
		border-right: 1px solid var(--color-border);
		overflow: hidden;
	}

	/* ── Resize handle ── */
	.resize-handle {
		position: absolute;
		right: -2px;
		top: 0;
		bottom: 0;
		width: 5px;
		cursor: col-resize;
		z-index: 10;
		background: transparent;
	}

	/* The visible 1px line — centered in the 5px hit area */
	.resize-handle::after {
		content: '';
		position: absolute;
		inset: 0;
		left: 2px;
		width: 1px;
		background: var(--color-border);
		transition:
			width 120ms ease,
			left 120ms ease,
			background-color 120ms ease;
	}

	.resize-handle:hover::after,
	.resize-handle:active::after {
		left: 1px;
		width: 3px;
		background: var(--color-border-focus, var(--color-accent));
	}

	/* ── Top bar ── */
	.topbar-area {
		grid-area: topbar;
		position: relative;
		z-index: 10;
		height: 20px;
		background: var(--color-bg-primary);
		border-bottom: 1px solid color-mix(in srgb, var(--color-border) 40%, transparent);
	}

	/* Tauri overlay title bar — traffic light clearance */
	:global(html.tauri) .topbar-area {
		height: calc(22px + 6px);
		padding-top: 22px;
	}

	/* ── Main area ── */
	.main-area {
		grid-area: main;
		overflow: hidden;
		min-height: 0;
		min-width: 0;
	}

	.tabs-float {
		/* Viewport-centred. The topbar spans the full viewport (grid-area
		   'topbar topbar'), so `left: 50%` resolves to 50vw. We deliberately
		   do NOT offset by the sidebar width — the tabs are anchored to the
		   viewport, not the main-area, so toggling or dragging the sidebar
		   doesn't shift them horizontally. This matches the walkthrough
		   content column's viewport-anchored centre (see
		   GuidedWalkthrough.svelte, `.walkthrough-content`). */
		position: absolute;
		top: 100%;
		left: 50%;
		transform: translateX(-50%);
		z-index: 20;
		pointer-events: none;
		padding-top: 12px;
	}

	.tabs-float :global(*) {
		pointer-events: auto;
	}

	.bottombar-area {
		grid-area: bottombar;
		border-top: 1px solid var(--color-border);
	}

	/* Bottom-anchored mirror of `.tabs-float`. Sits 12px above the 40px
	   bottombar, viewport-centred via `left: 50%` so a sidebar collapse/
	   resize does not shift it horizontally. `pointer-events: none` on the
	   wrapper prevents the invisible padding zone from swallowing clicks
	   meant for content below. */
	.walkthrough-actions-float {
		position: absolute;
		bottom: 40px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 20;
		pointer-events: none;
		padding-bottom: 12px;
	}

	.walkthrough-actions-float :global(*) {
		pointer-events: auto;
	}

	.walkthrough-actions-row {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	/* Glass pill — mirrors `.pill-segment` in FloatingTabs.svelte so the
	   bottom action and the top tabs read as members of the same family. */
	.walkthrough-action-btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 36px;
		padding: 0 16px;
		background: var(--color-tab-track-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		border-radius: 9999px;
		box-shadow:
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
		font-family: inherit;
		font-size: 13px;
		font-weight: 500;
		letter-spacing: -0.01em;
		line-height: 1;
		color: var(--color-text-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap),
			box-shadow var(--duration-snap);
		-webkit-font-smoothing: antialiased;
		white-space: nowrap;
	}

	.walkthrough-action-btn:hover {
		background: color-mix(in srgb, var(--color-tab-active-bg) 80%, var(--color-tab-track-bg));
	}

	.walkthrough-action-btn:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.walkthrough-action-btn--danger {
		color: var(--color-danger);
	}

	.walkthrough-action-btn--muted {
		color: var(--color-text-secondary);
	}

	/* Submit Review — accent blue tint */
	.walkthrough-action-btn--accent:not(:disabled) {
		color: var(--color-accent);
	}

	/* Approve — success green tint */
	.walkthrough-action-btn--success:not(:disabled) {
		color: var(--color-success);
	}

	/* Disabled state for RC buttons */
	.walkthrough-action-btn:disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}

	/* ── Right pane (chat) ──
	   Overlay-positioned, NOT a grid column. Toggling it open/closed must
	   leave the main grid (sidebar + main + bottombar) byte-identical so
	   the walkthrough/page-title/Request Changes content does not shift,
	   reflow, or rewrap. The user's spec was "behave exactly like the left
	   pane: do not change the main content display"; the left pane achieves
	   non-disruption via viewport-anchored math inside the inner grids,
	   but the right pane sits to the right of the 380px annotation rail
	   where that math cannot absorb a 340px column without squeezing the
	   820px content track. Overlay sidesteps the geometric impossibility:
	   main-area width is independent of right-pane state.

	   Position: top below the 20px topbar (28px in Tauri to clear the
	   traffic-light row), right at viewport edge, bottom above the 40px
	   bottombar. Slides in/out via translateX so the panel can keep its
	   chat state mounted across toggles. */
	.rightpanel-area {
		position: absolute;
		top: 20px;
		right: 0;
		bottom: 40px;
		width: 340px;
		border-left: 1px solid var(--color-border-subtle);
		overflow: hidden;
		background: var(--color-panel-bg);
		transform: translateX(100%);
		transition: transform 100ms var(--ease-out-expo);
		/* Above main content, below topbar/CommandPalette. */
		z-index: 5;
	}

	.rightpanel-area--open {
		transform: translateX(0);
	}

	/* Tauri overlay title bar — topbar is taller, so the right pane starts
	   lower to clear the traffic lights. Mirrors `.topbar-area` height. */
	:global(html.tauri) .rightpanel-area {
		top: calc(22px + 6px);
	}
</style>
