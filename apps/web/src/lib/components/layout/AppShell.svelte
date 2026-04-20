<script lang="ts">
	import Sidebar from './Sidebar.svelte';
	import TopBar from './TopBar.svelte';
	import RightPanel from './RightPanel.svelte';
	import BottomBar from './BottomBar.svelte';
	import CommandPalette from './CommandPalette.svelte';
	import FloatingTabs from './FloatingTabs.svelte';
	import { getSelectedPr } from '$lib/stores/prs.svelte';
	import { getPrWalkthroughStatus } from '$lib/stores/walkthrough.svelte';
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
	import { getTopbarCollapsed } from '$lib/stores/topbar.svelte';
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
	const topbarCollapsed = $derived(getTopbarCollapsed());
	const isSettingsRoute = $derived(page.url.pathname.startsWith('/settings'));

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

	const tabsStyle = $derived(
		sidebarCollapsed
			? ''
			: `--sidebar-offset: ${sidebarWidth / 2}px`
	);

	// Inline style for the grid — drives the dynamic sidebar column width
	const gridStyle = $derived(
		sidebarCollapsed
			? rightPanelOpen
				? 'grid-template-columns: 40px 1fr 340px'
				: 'grid-template-columns: 40px 1fr'
			: rightPanelOpen
				? `grid-template-columns: ${sidebarWidth}px 1fr 340px`
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
	class:panel-open={rightPanelOpen}
	class:is-resizing={isDragging}
	class:topbar-compact={topbarCollapsed}
	style={gridStyle}
>
	<aside class="sidebar-area">
		<Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />

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
		<TopBar {rightPanelOpen} onTogglePanel={toggleRightPanel} />
		{#if pr && !isSettingsRoute}
			<div class="tabs-float" style={tabsStyle}>
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

	{#if rightPanelOpen}
		<aside class="rightpanel-area">
			<RightPanel onClose={toggleRightPanel} prId={page.params['prId'] ?? ''} />
		</aside>
	{/if}
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
		background-color: var(--color-bg-primary);
		transition:
			grid-template-columns 100ms var(--ease-out-expo),
			grid-template-rows 100ms var(--ease-out-expo);
	}

	/* Suppress the column transition while dragging so resize feels instant */
	.app-shell.is-resizing {
		transition: none;
	}

	.app-shell.is-resizing .tabs-float {
		transition: none;
	}

	/* Right panel — update grid areas */
	.app-shell.panel-open {
		grid-template-areas:
			'topbar  topbar     topbar'
			'sidebar main       rightpanel'
			'sidebar bottombar  rightpanel';
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
		position: absolute;
		top: 100%;
		left: 50%;
		transform: translateX(calc(-50% + var(--sidebar-offset, 0px)));
		z-index: 20;
		pointer-events: none;
		padding-top: 12px;
		transition: transform 100ms var(--ease-out-expo);
	}

	.tabs-float :global(*) {
		pointer-events: auto;
	}

	.bottombar-area {
		grid-area: bottombar;
		border-top: 1px solid var(--color-border);
	}

	.rightpanel-area {
		grid-area: rightpanel;
		border-left: 1px solid var(--color-border-subtle);
		overflow-y: auto;
		animation: slide-in var(--duration-smooth) var(--ease-out-expo);
	}

	@keyframes slide-in {
		from {
			opacity: 0;
			transform: translateX(16px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>
