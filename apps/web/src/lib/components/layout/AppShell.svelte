<script lang="ts">
import { page } from "$app/state";
import SettingsModal from "$lib/components/settings/SettingsModal.svelte";
import UserMenu from "$lib/components/sidebar/UserMenu.svelte";
import { RAIL_WIDTH } from "$lib/constants";
import { getSelectedPr } from "$lib/stores/prs.svelte";
import {
  getActiveTab,
  getIsPullingCommit,
  getLoadedHeadSha,
  getReviewFiles,
  pullLatestCommit,
  setActiveTab,
} from "$lib/stores/review.svelte";
import { closeSettings, getSettingsOpen } from "$lib/stores/settingsModal.svelte";
import { closePalette, getPaletteMode, getPaletteOpen } from "$lib/stores/shortcuts.svelte";
import {
  getRightPanelOpen,
  getRightPanelWidth,
  getSidebarCollapsed,
  getSidebarPeekHovering,
  getSidebarView,
  getSidebarWidth,
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  resetRightPanelWidth,
  resetSidebarWidth,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  setRightPanelOpen,
  setRightPanelWidth,
  setSidebarWidth,
  toggleRightPanel,
  toggleSidebar,
} from "$lib/stores/sidebar.svelte";
import { getPrWalkthroughStatus } from "$lib/stores/walkthrough.svelte";
import BottomBar from "./BottomBar.svelte";
import CommandPalette from "./CommandPalette.svelte";
import FloatingTabs from "./FloatingTabs.svelte";
import ProjectRail from "./ProjectRail.svelte";
import RequestChangesActionBar from "./RequestChangesActionBar.svelte";
import RightPanel from "./RightPanel.svelte";
import Sidebar from "./Sidebar.svelte";
import TopBar from "./TopBar.svelte";
import WalkthroughActionBar from "./WalkthroughActionBar.svelte";

let { children } = $props();

const LARGE_FILE_TREE_ANIMATION_THRESHOLD = 120;

const sidebarCollapsed = $derived(getSidebarCollapsed());
// Effective collapsed state: false when the user is hovering a project
// avatar (or the sidebar itself) so the column expands as a peek without
// flipping the persistent toggle. Used for layout (grid columns, floating
// action bar alignment, Sidebar contents). The TopBar toggle and the
// resize handle stay bound to the real `sidebarCollapsed` so peek is
// purely visual and never repositions controls.
const sidebarPeekHovering = $derived(getSidebarPeekHovering());
const sidebarEffectiveCollapsed = $derived(sidebarCollapsed && !sidebarPeekHovering);
const rightPanelOpen = $derived(getRightPanelOpen());
const paletteOpen = $derived(getPaletteOpen());
const paletteMode = $derived(getPaletteMode());
const sidebarWidth = $derived(getSidebarWidth());
const rightPanelWidth = $derived(getRightPanelWidth());
const sidebarView = $derived(getSidebarView());
const reviewFiles = $derived(getReviewFiles());
const pr = $derived(getSelectedPr());
const walkthroughStatus = $derived(pr ? getPrWalkthroughStatus(pr.id) : "idle");
const activeTab = $derived(getActiveTab());
const isSettingsRoute = $derived(page.url.pathname.startsWith("/settings"));
const isReviewRoute = $derived(page.url.pathname.startsWith("/review/"));
const shouldSnapSidebarLayout = $derived(
  sidebarView === "files" && reviewFiles.length >= LARGE_FILE_TREE_ANIMATION_THRESHOLD,
);
const showFloatingActions = $derived(
  !!pr && isReviewRoute && !isSettingsRoute && activeTab === "walkthrough",
);
const showRcActions = $derived(
  !!pr && isReviewRoute && !isSettingsRoute && activeTab === "request-changes",
);

// New-commit-available signal: the PR's current headSha differs from the
// SHA the diff was loaded against. `getLoadedHeadSha` returns null until the
// first successful fetch, suppressing the signal on fresh visits.
const hasNewCommit = $derived.by(() => {
  if (!pr?.headSha) return false;
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

// Right-pane drag state — separate from sidebar so a drag on one handle
// can't be confused with the other and the resize-suppression class
// applies independently.
let isResizingRight = $state(false);
let rightDragStartX = 0;
let rightDragStartWidth = 0;

// Close the chat panel when navigating away from a PR page
$effect(() => {
  if (!pr && rightPanelOpen) {
    setRightPanelOpen(false);
  }
});

// Inline style for the grid — drives the dynamic sidebar AND right-panel
// column widths. The right pane is a real grid column whose width
// collapses to 0 when closed; opening it shrinks the main column rather
// than overlaying on top of it. Animation comes from the
// grid-template-columns transition on .app-shell.
const gridStyle = $derived(
  `grid-template-columns: ${RAIL_WIDTH}px ${sidebarEffectiveCollapsed ? "0" : `${sidebarWidth}px`} 1fr ${rightPanelOpen ? `${rightPanelWidth}px` : "0"}; --right-panel-width: ${rightPanelWidth}px`,
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
  const newWidth = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, dragStartWidth + delta));
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

function onRightHandlePointerDown(event: PointerEvent): void {
  if (!rightPanelOpen) return;
  event.preventDefault();
  isResizingRight = true;
  rightDragStartX = event.clientX;
  rightDragStartWidth = rightPanelWidth;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onRightHandlePointerMove(event: PointerEvent): void {
  if (!isResizingRight) return;
  // Dragging left grows the panel, dragging right shrinks it — invert delta.
  const delta = rightDragStartX - event.clientX;
  const newWidth = Math.max(
    RIGHT_PANEL_WIDTH_MIN,
    Math.min(RIGHT_PANEL_WIDTH_MAX, rightDragStartWidth + delta),
  );
  setRightPanelWidth(newWidth);
}

function onRightHandlePointerUp(event: PointerEvent): void {
  if (!isResizingRight) return;
  isResizingRight = false;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
}

function onRightHandleDblClick(): void {
  resetRightPanelWidth();
}
</script>

<div
	class="app-shell"
	class:sidebar-collapsed={sidebarEffectiveCollapsed}
	class:is-resizing={isDragging || isResizingRight}
	class:snap-sidebar-layout={shouldSnapSidebarLayout}
	style={gridStyle}
>
	<aside class="rail-area">
		<ProjectRail />
	</aside>

	<aside class="sidebar-area">
		<Sidebar collapsed={sidebarEffectiveCollapsed} />

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
	</header>

	<main class="main-area">
		{#if pr && isReviewRoute && !isSettingsRoute}
			<div class="main-tab-bar">
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
		<div class="main-content">
			{@render children()}
		</div>

		{#if showFloatingActions && pr}
			<WalkthroughActionBar prId={pr.id} />
		{/if}

		{#if showRcActions}
			<RequestChangesActionBar />
		{/if}
	</main>

	<aside class="userbar-area">
		<UserMenu collapsed={sidebarEffectiveCollapsed} />
	</aside>

	<footer class="bottombar-area">
		<BottomBar />
	</footer>

	<aside
		class="rightpanel-area"
		class:rightpanel-area--open={rightPanelOpen}
		aria-hidden={!rightPanelOpen}
	>
		{#if rightPanelOpen}
			<div
				class="right-resize-handle"
				role="separator"
				aria-label="Resize right panel"
				aria-orientation="vertical"
				tabindex="-1"
				onpointerdown={onRightHandlePointerDown}
				onpointermove={onRightHandlePointerMove}
				onpointerup={onRightHandlePointerUp}
				ondblclick={onRightHandleDblClick}
			></div>
		{/if}
		<RightPanel onClose={toggleRightPanel} prId={page.params['prId'] ?? ''} />
	</aside>
</div>

<CommandPalette open={paletteOpen} mode={paletteMode} onClose={closePalette} />
<SettingsModal open={getSettingsOpen()} onClose={closeSettings} />

<style>
	.app-shell {
		display: grid;
		grid-template-rows: auto 1fr calc(var(--bottombar-height) + var(--spacing-island));
		grid-template-areas:
			'topbar  topbar  topbar    topbar'
			'rail    sidebar main      rightpanel'
			'userbar userbar bottombar bottombar';
		height: 100vh;
		width: 100vw;
		overflow: hidden;
		/* Positioning context for the absolutely-positioned right pane. */
		position: relative;
		background-color: var(--color-bg-secondary);
	transition:
		grid-template-columns var(--duration-smooth) var(--ease-out-expo),
		grid-template-rows var(--duration-smooth) var(--ease-out-expo);
	}

	/* Suppress the column transition while dragging so resize feels instant */
	.app-shell.is-resizing {
		transition: none;
	}

	/* Large file trees are already virtualized, but animating the grid column
	   still forces layout through the tree's shadow DOM every frame. Snap the
	   outer layout in that case; the inner sidebar drawer keeps its transform
	   transition for normal view switches. */
	.app-shell.snap-sidebar-layout {
		transition: none;
	}

	/* ── Rail (always-visible project switcher) ── */
	.rail-area {
		grid-area: rail;
		position: relative;
		overflow: hidden;
		/* Match the chrome gap on the rail's right (which comes from main's
		   margin) so the rail's icons read as visually centered between
		   viewport edge and main pane when the sidebar is collapsed. */
		padding-left: var(--spacing-island);
	}

	/* ── Sidebar area ── */
	.sidebar-area {
		grid-area: sidebar;
		position: relative;
		overflow: hidden;
		contain: layout paint;
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

	/* Visible only on hover/active — transparent at rest so the handle
	   doesn't print a hairline into the chrome gap. */
	.resize-handle::after {
		content: '';
		position: absolute;
		inset: 0;
		left: 2px;
		width: 1px;
		background: transparent;
		transition:
			width var(--duration-snap) var(--ease-soft),
			left var(--duration-snap) var(--ease-soft),
			background-color var(--duration-snap) var(--ease-soft);
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
		height: var(--topbar-height);
		background: var(--color-bg-secondary);
	}

	/* Tauri overlay title bar — traffic light clearance */
	:global(html.tauri) .topbar-area {
		height: calc(22px + var(--spacing-island));
		padding-top: 22px;
	}

	/* ── Main area ── */
	.main-area {
		grid-area: main;
		position: relative;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		min-height: 0;
		min-width: 0;
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-island);
		margin: var(--spacing-island);
		/* Layered shadow: tight contact + soft ambient.
		   Inset top highlight catches light off the warm canvas. */
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 60%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 6%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 10%, transparent);
	}

	/* Tabs float over content — no background, no flex space reservation.
	   The pill already has backdrop-filter so content scrolling beneath
	   shows through naturally. pointer-events passthrough on the wrapper
	   so clicks reach content in the transparent zone around the pill. */
	.main-tab-bar {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 10;
		display: flex;
		justify-content: center;
		padding: 10px 0 8px;
		pointer-events: none;
	}

	.main-tab-bar :global(*) {
		pointer-events: auto;
	}

	.main-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	:global(:root.dark) .main-area {
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 4%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 40%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 50%, transparent);
	}

	/* ── Userbar (bottom-left chrome strip holding the user menu) ──
	   Spans the rail + sidebar columns in row 3, sharing the row with the
	   bottombar to its right. Together they form one continuous chrome band
	   across the bottom of the viewport — same bg, same height, no divider.
	   Separation from the scrolling PR list (and the rail's avatar column)
	   above is handled by an in-pane fade overlay at the bottom of each
	   column (.sidebar-fade, .rail-fade) so content dissolves into the
	   chrome instead of hitting a hard edge. */
	.userbar-area {
		grid-area: userbar;
		background: var(--color-bg-secondary);
		padding-left: var(--spacing-island);
		padding-bottom: var(--spacing-island);
		display: flex;
		align-items: center;
		overflow: visible;
		position: relative;
		z-index: 10;
		min-width: 0;
	}

	.bottombar-area {
		grid-area: bottombar;
		padding-bottom: var(--spacing-island);
	}

	/* ── Right pane (chat) ──
	   A real grid column. Width is 0 when closed, rightPanelWidth when
	   open; toggling shrinks the main column rather than overlaying. The
	   open/close animation comes from the grid-template-columns transition
	   on .app-shell.

	   Margin pattern mirrors .main-area's island (top / bottom / right =
	   spacing-island) but margin-left is 0 — main's own margin-right
	   already produces the chrome gap between the two islands, so adding
	   margin-left here would double it. */
	.rightpanel-area {
		grid-area: rightpanel;
		position: relative;
		overflow: hidden;
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-island);
		margin: var(--spacing-island) var(--spacing-island) var(--spacing-island) 0;
		/* Mirrors .main-area's island elevation so both panes float
		   identically inside the chrome. */
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 60%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 6%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 10%, transparent);
		/* min-width: 0 lets the grid track shrink to 0 even though the
		   border-box would otherwise contribute its own min-content. */
		min-width: 0;
		/* Slide in/out from the right rather than growing in place. The
		   translateX is keyed to --right-panel-width so it always moves
		   the full panel width regardless of the current grid column value. */
		transform: translateX(0);
		transition:
			transform var(--duration-smooth) var(--ease-out-expo),
			border-color var(--duration-smooth) var(--ease-out-expo),
			box-shadow var(--duration-smooth) var(--ease-out-expo);
	}

	:global(:root.dark) .rightpanel-area {
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 4%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 40%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 50%, transparent);
	}

	/* When closed: slide the panel off to the right so it enters/exits
	   from outside the viewport rather than growing in place. The
	   --right-panel-width CSS var (set via inline style on .app-shell)
	   provides the fixed pixel offset regardless of column width. */
	.rightpanel-area:not(.rightpanel-area--open) {
		transform: translateX(var(--right-panel-width));
		border-color: transparent;
		box-shadow: none;
	}

	/* Left-edge resize handle — mirrors `.resize-handle` on the sidebar but
	   anchored to the panel's *left* edge (toward the main pane). 5px hit
	   area, 1px visible line, expands to 3px on hover/active using the
	   accent border color. */
	.right-resize-handle {
		position: absolute;
		left: -2px;
		top: 0;
		bottom: 0;
		width: 5px;
		cursor: col-resize;
		z-index: 10;
		background: transparent;
	}

	.right-resize-handle::after {
		content: '';
		position: absolute;
		inset: 0;
		left: 2px;
		width: 1px;
		background: transparent;
		transition:
			width var(--duration-snap) var(--ease-soft),
			left var(--duration-snap) var(--ease-soft),
			background-color var(--duration-snap) var(--ease-soft);
	}

	.right-resize-handle:hover::after,
	.right-resize-handle:active::after {
		left: 1px;
		width: 3px;
		background: var(--color-border-focus, var(--color-accent));
	}
</style>
