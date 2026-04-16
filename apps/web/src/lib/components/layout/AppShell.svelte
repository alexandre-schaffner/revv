<script lang="ts">
	import Sidebar from './Sidebar.svelte';
	import TopBar from './TopBar.svelte';
	import RightPanel from './RightPanel.svelte';
	import BottomBar from './BottomBar.svelte';
	import CommandPalette from './CommandPalette.svelte';
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
	import { getPanelOpenRequested, consumePanelOpenRequest } from '$lib/stores/review.svelte';
	import { page } from '$app/state';

	let { children } = $props();

	const sidebarCollapsed = $derived(getSidebarCollapsed());
	const rightPanelOpen = $derived(getRightPanelOpen());
	const paletteOpen = $derived(getPaletteOpen());
	const paletteMode = $derived(getPaletteMode());
	const sidebarWidth = $derived(getSidebarWidth());

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

	<header class="topbar-area">
		<TopBar {rightPanelOpen} onTogglePanel={toggleRightPanel} />
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
		grid-template-rows: 48px 1fr 40px;
		grid-template-areas:
			'sidebar topbar'
			'sidebar main'
			'sidebar bottombar';
		height: 100vh;
		width: 100vw;
		overflow: hidden;
		background-color: var(--color-bg-primary);
		transition: grid-template-columns var(--duration-smooth) var(--ease-out-expo);
	}

	/* Suppress the column transition while dragging so resize feels instant */
	.app-shell.is-resizing {
		transition: none;
	}

	/* Right panel — update grid areas */
	.app-shell.panel-open {
		grid-template-areas:
			'sidebar topbar rightpanel'
			'sidebar main rightpanel'
			'sidebar bottombar rightpanel';
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

	/* ── Other areas ── */
	.topbar-area {
		grid-area: topbar;
	}

	.main-area {
		grid-area: main;
		overflow-y: auto;
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
