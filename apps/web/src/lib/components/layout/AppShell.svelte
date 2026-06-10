<script lang="ts">
import type { ReviewMode } from "@revv/shared";
import { page } from "$app/state";
import SettingsModal from "$lib/components/settings/SettingsModal.svelte";
import UserMenu from "$lib/components/sidebar/UserMenu.svelte";
import { RAIL_WIDTH } from "$lib/constants";
import { gsap, gsapFade, tokens } from "$lib/motion";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { getSelectedPr } from "$lib/stores/prs.svelte";
import {
  getActiveTab,
  getIsPullingCommit,
  getLoadedHeadSha,
  getReviewMode,
  pullLatestCommit,
  selectReviewMode,
  setActiveTab,
} from "$lib/stores/review.svelte";
import { closeSettings, getSettingsOpen } from "$lib/stores/settingsModal.svelte";
import { closePalette, getPaletteMode, getPaletteOpen } from "$lib/stores/shortcuts.svelte";
import {
  getRightPanelOpen,
  getRightPanelWidth,
  getSidebarCollapsed,
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

const sidebarCollapsed = $derived(getSidebarCollapsed());
const rightPanelOpen = $derived(getRightPanelOpen());
const paletteOpen = $derived(getPaletteOpen());
const paletteMode = $derived(getPaletteMode());
const sidebarWidth = $derived(getSidebarWidth());
const rightPanelWidth = $derived(getRightPanelWidth());
const pr = $derived(getSelectedPr());
const walkthroughStatus = $derived(pr ? getPrWalkthroughStatus(pr.id) : "idle");
const activeTab = $derived(getActiveTab());
const isSettingsRoute = $derived(page.url.pathname.startsWith("/settings"));
const isReviewRoute = $derived(page.url.pathname.startsWith("/review/"));
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

// Review lens (Reviewer / Self-review) surfaced in the floating tab bar so it
// stays visible across all three tabs. Defaults to self-review when the
// signed-in user authored the PR. The page route owns hydration
// (`ensureReviewMode`); here we only read the resolved value and forward the
// switch action — which only swaps context, never starts generation.
const currentUserLogin = $derived(getCurrentUserLogin());
const defaultReviewMode = $derived<ReviewMode>(
  pr?.authorLogin && currentUserLogin && pr.authorLogin === currentUserLogin
    ? "author"
    : "reviewer",
);
const reviewMode = $derived(pr ? getReviewMode(pr.id, defaultReviewMode) : undefined);
function onReviewModeChange(mode: ReviewMode): void {
  if (pr) selectReviewMode(pr.id, mode);
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

// Right panel appears/disappears instantly, same as the sidebar — snap the
// panel's translateX (off-screen ↔ 0) and the main-area vignette on every
// toggle, no tween. The vignette softens the main pane's clipped right edge
// while the chat panel covers it. The closed-state transform also lives in
// CSS (`.rightpanel-area`) so an open-on-reload panel paints correctly before
// this effect attaches.
let panelEl = $state<HTMLElement | null>(null);
let mainEl = $state<HTMLElement | null>(null);

$effect(() => {
  const open = rightPanelOpen;
  const width = rightPanelWidth;
  if (!panelEl || !mainEl) return;
  // gsap.set (not panelEl.style.transform): it writes the same
  // `transform: translate3d(...)` format as the CSS fallback on
  // `.rightpanel-area`, so the inline write and the static rule agree on
  // units and there's no first-paint flash. Don't "simplify" to a plain
  // style write — that risks format drift against the CSS fallback.
  gsap.set(panelEl, { x: open ? 0 : width });
  mainEl.style.setProperty("--vignette-opacity", open ? "0.65" : "0");
});

const gridStyle = $derived(
  `grid-template-columns: ${RAIL_WIDTH}px ${sidebarCollapsed ? 0 : sidebarWidth}px 1fr ${rightPanelOpen ? rightPanelWidth : 0}px; --sidebar-width: ${sidebarWidth}px; --right-panel-width: ${rightPanelWidth}px`,
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
	class:sidebar-collapsed={sidebarCollapsed}
	class:rightpanel-open={rightPanelOpen}
	style={gridStyle}
>
	<aside class="rail-area">
		<ProjectRail />
	</aside>

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
	</header>

	<main class="main-area" bind:this={mainEl}>
		{#if pr && isReviewRoute && !isSettingsRoute}
			<div class="tabs-float">
				<FloatingTabs
					{activeTab}
					onTabChange={setActiveTab}
					{walkthroughStatus}
					{hasNewCommit}
					{isPulling}
					{onPullCommit}
					{reviewMode}
					{onReviewModeChange}
				/>
			</div>
		{/if}
		<div class="main-content">
			<!--
				Keyed inner wrapper: re-mounts on every navigation so a Svelte
				transition fires cleanly without touching the persistent
				.main-content (which would briefly hide every fixed chrome child
				underneath). Tagged data-page-root so page-transitions.ts can find
				it for Flip morphs; the default crossfade is the transition below.
			-->
			{#key page.url.pathname}
				<div class="page-slot" data-page-root in:gsapFade={{ duration: tokens.quick }}>
					{@render children()}
				</div>
			{/key}
		</div>

		{#if showFloatingActions && pr}
			<WalkthroughActionBar prId={pr.id} />
		{/if}

		{#if showRcActions}
			<RequestChangesActionBar />
		{/if}
	</main>

	<aside class="userbar-area">
		<UserMenu collapsed={sidebarCollapsed} />
	</aside>

	<footer class="bottombar-area">
		<BottomBar />
	</footer>

	<div class="rightpanel-slot">
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
</div>

<CommandPalette
	open={paletteOpen}
	mode={paletteMode}
	onOpenChange={(v) => {
		if (!v) closePalette();
	}}
/>
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
		/* No transition on grid-template-columns: tweening the track relayouts
		   the resize-observing @pierre diff in the main pane on every frame,
		   tanking the toggle to single-digit fps. Both panes toggle instantly —
		   the sidebar via the grid track, the right panel via the snapped
		   translateX in the right-panel $effect above. */
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

	/* Right-edge vignette that appears when the panel opens, softening the
	   hard clip as the main area loses width to the panel. Opacity is set
	   directly (`--vignette-opacity`) by the right-panel $effect above —
	   instant, no tween, in lockstep with the panel's snapped translateX. */
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

	.main-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
	}

	.page-slot {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
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
	   `.rightpanel-slot` is the grid cell whose width snaps 0 ↔
	   rightPanelWidth; that drives the main column's shrink/grow.
	   `.rightpanel-area` is absolutely-positioned inside it at a stable
	   width so its contents never reflow when the track changes. The panel's
	   translateX (off-screen ↔ 0) is snapped via `gsap.set` in the
	   right-panel $effect above — instant, matching the grid track. */
	.rightpanel-slot {
		grid-area: rightpanel;
		position: relative;
	}

	.rightpanel-area {
		position: absolute;
		top: var(--spacing-island);
		right: var(--spacing-island);
		bottom: var(--spacing-island);
		width: calc(var(--right-panel-width) - var(--spacing-island));
		overflow: hidden;
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-island);
		/* Mirrors .main-area's island elevation so both panes float
		   identically inside the chrome. */
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 60%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 6%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 10%, transparent);
		/* First-paint transform for the closed state. The right-panel $effect
		   above takes over once it first runs, writing the transform inline
		   (which beats this rule on specificity). Keeping the static CSS means
		   an open-on-reload panel renders at its correct resting position
		   without a one-frame flash before JS attaches. */
		transform: translateX(var(--right-panel-width));
	}

	.rightpanel-area.rightpanel-area--open {
		transform: translateX(0);
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
