<script lang="ts">
import { untrack } from "svelte";
import { page } from "$app/state";
import SettingsModal from "$lib/components/settings/SettingsModal.svelte";
import UserMenu from "$lib/components/sidebar/UserMenu.svelte";
import { RAIL_WIDTH } from "$lib/constants";
import { gsap, prefersReducedMotion, tokens } from "$lib/motion";
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

// Element refs for GSAP-driven choreography (right panel slide, vignette).
let panelEl: HTMLElement | null = $state(null);
let mainEl: HTMLElement | null = $state(null);

// GSAP-animated proxies for the grid track widths. Reading these into the
// grid-template-columns string lets a single tween smoothly interpolate the
// numeric value across both the sidebar collapse and the right-panel open/
// close transitions. Initial values match the resting state of the layout;
// `untrack` prevents Svelte from treating the initializer as a derived
// (the values change later via the $effect blocks, not via re-init).
let animatedSidebarTrackPx = $state(
  untrack(() => (sidebarEffectiveCollapsed ? 0 : sidebarWidth)),
);
let animatedRightPanelTrackPx = $state(
  untrack(() => (rightPanelOpen ? rightPanelWidth : 0)),
);

// First-mount flag — on first run we snap rather than tween, so the panel
// appears at its resting position without playing an open/close animation
// on initial paint.
let panelChoreographed = false;

// Close the chat panel when navigating away from a PR page
$effect(() => {
  if (!pr && rightPanelOpen) {
    setRightPanelOpen(false);
  }
});

// Sidebar column width tween. Triggered by collapse-state changes and by
// width changes that aren't driven by a live drag. Dragging snaps instantly
// to avoid trailing the cursor.
$effect(() => {
  const target = sidebarEffectiveCollapsed ? 0 : sidebarWidth;
  // Live drag: snap. Reduced-motion: snap. Large file trees: snap, because
  // animating the grid column re-runs layout through a virtualized tree on
  // every frame and produces visible jank — the previous CSS had the same
  // carve-out via the `.snap-sidebar-layout` class.
  if (isDragging || shouldSnapSidebarLayout || prefersReducedMotion()) {
    animatedSidebarTrackPx = target;
    return;
  }
  const proxy = { v: animatedSidebarTrackPx };
  const t = gsap.to(proxy, {
    v: target,
    duration: tokens.smooth,
    ease: tokens.easeOutExpo,
    overwrite: "auto",
    onUpdate() {
      animatedSidebarTrackPx = proxy.v;
    },
  });
  return () => {
    t.kill();
  };
});

// Right-panel choreography: a single timeline drives both the grid column
// width and the panel's translateX so they never desync. The vignette on
// the main area's right edge is animated via a CSS custom property so the
// pseudo-element can pick it up without a separate element.
$effect(() => {
  const open = rightPanelOpen;
  const targetTrack = open ? rightPanelWidth : 0;
  const targetTranslateX = open ? 0 : rightPanelWidth;
  const targetVignette = open ? 0.65 : 0;

  // First-mount snap — avoids playing an open/close animation on initial
  // paint when the panel is just settling into its resting position.
  const firstRun = !panelChoreographed && panelEl !== null;
  if (firstRun) {
    panelChoreographed = true;
    animatedRightPanelTrackPx = targetTrack;
    if (panelEl) gsap.set(panelEl, { x: targetTranslateX });
    if (mainEl) mainEl.style.setProperty("--vignette-opacity", String(targetVignette));
    return;
  }

  if (isResizingRight) {
    // Live resize: jump to the new width on every drag move.
    animatedRightPanelTrackPx = targetTrack;
    if (panelEl) gsap.set(panelEl, { x: 0 });
    return;
  }

  if (prefersReducedMotion()) {
    animatedRightPanelTrackPx = targetTrack;
    if (panelEl) gsap.set(panelEl, { x: targetTranslateX });
    if (mainEl) mainEl.style.setProperty("--vignette-opacity", String(targetVignette));
    return;
  }

  const trackProxy = { v: animatedRightPanelTrackPx };
  const vignetteProxy = { v: getCurrentVignette() };
  const t = gsap.timeline();
  t.to(
    trackProxy,
    {
      v: targetTrack,
      duration: tokens.smooth,
      ease: tokens.easeOutExpo,
      onUpdate() {
        animatedRightPanelTrackPx = trackProxy.v;
      },
    },
    0,
  );
  if (panelEl) {
    t.to(
      panelEl,
      {
        x: targetTranslateX,
        duration: tokens.smooth,
        ease: tokens.easeOutExpo,
      },
      0,
    );
  }
  if (mainEl) {
    t.to(
      vignetteProxy,
      {
        v: targetVignette,
        duration: tokens.smooth,
        ease: tokens.easeOutExpo,
        onUpdate() {
          mainEl?.style.setProperty("--vignette-opacity", String(vignetteProxy.v));
        },
      },
      0,
    );
  }
  return () => {
    t.kill();
  };
});

function getCurrentVignette(): number {
  if (!mainEl) return 0;
  const raw = mainEl.style.getPropertyValue("--vignette-opacity");
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Inline style for the grid — drives the dynamic sidebar AND right-panel
// column widths. Both proxy values are tweened by GSAP above; the
// derived string just composes them into the grid-template-columns CSS.
const gridStyle = $derived(
  `grid-template-columns: ${RAIL_WIDTH}px ${animatedSidebarTrackPx}px 1fr ${animatedRightPanelTrackPx}px; --right-panel-width: ${rightPanelWidth}px`,
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
	class:rightpanel-open={rightPanelOpen}
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

	<main class="main-area" bind:this={mainEl}>
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
		bind:this={panelEl}
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
	/* grid-template-columns is driven by GSAP-animated numeric proxies in
	   the script ($effect blocks). The previous CSS transition is removed —
	   GSAP is the single source of truth for column-width interpolation. */
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

	/* Right-edge vignette that fades in when the panel opens, softening the
	   hard clip as the main area loses width to the panel. Opacity is animated
	   by GSAP through the `--vignette-opacity` custom property set on the
	   .main-area element (see the right-panel $effect in the script). */
	.main-area::after {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: calc(var(--spacing-island) * 4);
		background: linear-gradient(to right, transparent, var(--color-bg-primary));
		opacity: var(--vignette-opacity, 0);
		pointer-events: none;
		z-index: 2;
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
		/* translateX is driven by GSAP from the right-panel $effect in the
		   script. The CSS rule below provides a first-paint fallback for the
		   resting closed state so the panel doesn't flash onto the viewport
		   between component mount and the first $effect run. Once GSAP starts
		   writing inline `transform`, it takes precedence (inline > class). */
	}

	.rightpanel-area:not(.rightpanel-area--open) {
		transform: translateX(var(--right-panel-width));
	}

	:global(:root.dark) .rightpanel-area {
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 4%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 40%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 50%, transparent);
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
