<script lang="ts">
import type { Snippet } from "svelte";
import { page } from "$app/state";
import SettingsModal from "$lib/components/settings/SettingsModal.svelte";
import UserMenu from "$lib/components/sidebar/UserMenu.svelte";
import StackMergeSheet from "$lib/components/stack/StackMergeSheet.svelte";
import { gsap, gsapFade, gsapFadeY, tokens } from "$lib/motion";
import { takeNavigationIntent } from "$lib/stores/navigation-intent.svelte";
import { getSelectedPr } from "$lib/stores/route.svelte";
import { closeSettings, getSettingsOpen } from "$lib/stores/settingsModal.svelte";
import { closePalette, getPaletteMode, getPaletteOpen } from "$lib/stores/shortcuts.svelte";
import {
  getChatStacked,
  getRightPanelOpen,
  getRightPanelWidth,
  getSidebarCollapsed,
  getSidebarWidth,
  RAIL_WIDTH,
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
import BottomBar from "./BottomBar.svelte";
import CommandPalette from "./CommandPalette.svelte";
import ProjectRail from "./ProjectRail.svelte";
import Sidebar from "./Sidebar.svelte";
import { provideShellChrome } from "./shell-chrome.svelte";
import TopBar from "./TopBar.svelte";

interface Props {
  children: Snippet;
  /** The right-hand panel's content (the chat). */
  rightPanel: Snippet;
}

let { children, rightPanel }: Props = $props();

const sidebarCollapsed = $derived(getSidebarCollapsed());
const rightPanelOpen = $derived(getRightPanelOpen());
const paletteOpen = $derived(getPaletteOpen());
const paletteMode = $derived(getPaletteMode());
const sidebarWidth = $derived(getSidebarWidth());
const rightPanelWidth = $derived(getRightPanelWidth());
// Slack-thread behaviour: wide enough → chat sits beside the main pane;
// too narrow → it takes the main pane over, with a back button in its header.
const chatStacked = $derived(getChatStacked());
const chatOverlay = $derived(rightPanelOpen && chatStacked);
const pr = $derived(getSelectedPr());
const chrome = provideShellChrome();

const PAGE_TRAVEL_PX = 14;

function pageEnter(node: Element) {
  const direction = takeNavigationIntent();
  if (!direction) return gsapFade(node, { duration: tokens.quick });
  return gsapFadeY(node, {
    y: direction === "up" ? -PAGE_TRAVEL_PX : PAGE_TRAVEL_PX,
    duration: tokens.smooth,
  });
}

let isDragging = $state(false);
let dragStartX = 0;
let dragStartWidth = 0;

let isResizingRight = $state(false);
let rightDragStartX = 0;
let rightDragStartWidth = 0;

$effect(() => {
  if (!pr && rightPanelOpen) {
    setRightPanelOpen(false);
  }
});

// The right panel snaps open and closed like the sidebar, never tweened (see
// `.app-shell`). The vignette softens the main pane's clipped right edge while
// the panel covers it.
let panelEl = $state<HTMLElement | null>(null);
let mainEl = $state<HTMLElement | null>(null);

$effect(() => {
  const open = rightPanelOpen;
  const width = rightPanelWidth;
  const stacked = chatStacked;
  if (!panelEl || !mainEl) return;
  // gsap.set, not a style write: it emits the same `translate3d(...)` format as
  // the CSS fallback on `.rightpanel-area`, so the two agree and the first
  // paint doesn't flash.
  gsap.set(panelEl, { x: open ? 0 : width });
  mainEl.style.setProperty("--vignette-opacity", open && !stacked ? "0.65" : "0");
});

// `--right-panel-width` is set on the panel element, not the shell: it's
// inherited, so writing it on `.app-shell` every drag frame recalculated style
// for the whole tree (~100ms/frame). A stacked chat claims no grid track: it
// overlays the main pane, whose resize-observing Pierre diff then never
// reflows on toggle.
const gridStyle = $derived(
  `grid-template-columns: ${RAIL_WIDTH}px ${sidebarCollapsed ? 0 : sidebarWidth}px 1fr ${rightPanelOpen && !chatStacked ? rightPanelWidth : 0}px; --sidebar-width: ${sidebarWidth}px`,
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
			subtitle={chrome.current.subtitle ?? null}
			{rightPanelOpen}
			onTogglePanel={toggleRightPanel}
			{sidebarCollapsed}
			onToggleSidebar={toggleSidebar}
		/>
	</header>

	<!-- `inert` while the chat is stacked over it: the main pane is covered, so
		 it shouldn't answer clicks, focus, or Tab. -->
	<main class="main-area" bind:this={mainEl} inert={chatOverlay}>
		{#if chrome.current.tabs}
			<div class="tabs-float">
				{@render chrome.current.tabs.snippet(chrome.current.tabs.prId)}
			</div>
		{/if}
		<div class="main-content">
			<!--
				Re-mounts on every navigation so the page transition fires without
				touching the persistent .main-content (hiding it would hide every
				fixed chrome child). page-transitions.ts finds it by data-page-root
				for Flip morphs.
			-->
			{#key page.url.pathname}
				<div class="page-slot" data-page-root in:pageEnter>
					{@render children()}
				</div>
			{/key}
		</div>

		{@render chrome.current.actions?.()}
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
			class:rightpanel-area--overlay={chatOverlay}
			style:--right-panel-width="{rightPanelWidth}px"
			style:--overlay-left="{RAIL_WIDTH + (sidebarCollapsed ? 0 : sidebarWidth)}px"
			aria-hidden={!rightPanelOpen}
		>
			{#if rightPanelOpen && !chatStacked}
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
			{@render rightPanel()}
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
<StackMergeSheet />

<style>
	.app-shell {
		display: grid;
		/* Both chrome rows are named so the stacked chat panel — which is
		   viewport-positioned, outside the grid — can derive the main pane's
		   box from the same numbers the grid uses. */
		--topbar-row-height: var(--topbar-height);
		--bottom-row-height: calc(var(--bottombar-height) + var(--spacing-island));
		grid-template-rows: var(--topbar-row-height) 1fr var(--bottom-row-height);
		grid-template-areas:
			'topbar  topbar  topbar    topbar'
			'rail    sidebar main      rightpanel'
			'userbar userbar bottombar bottombar';
		height: 100vh;
		width: 100vw;
		overflow: hidden;
		position: relative;
		background-color: var(--color-bg-secondary);
		/* No transition on grid-template-columns: tweening the track relayouts
		   the resize-observing Pierre diff every frame, dropping the toggle to
		   single-digit fps. */
	}

	.rail-area {
		grid-area: rail;
		position: relative;
		overflow: hidden;
		padding-left: var(--spacing-island);
	}

	.sidebar-area {
		grid-area: sidebar;
		position: relative;
		overflow: hidden;
		contain: layout paint;
	}

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

	.topbar-area {
		grid-area: topbar;
		position: relative;
		z-index: 10;
		height: var(--topbar-row-height);
		background: var(--color-bg-secondary);
	}

	/* Tauri overlay title bar — traffic light clearance */
	:global(html.tauri) .app-shell {
		--topbar-row-height: calc(22px + var(--spacing-island));
	}

	:global(html.tauri) .topbar-area {
		padding-top: 22px;
	}

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
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 60%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 6%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 10%, transparent);
	}

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

	/* `.rightpanel-slot` is the grid cell whose width snaps 0 ↔
	   rightPanelWidth; `.rightpanel-area` sits absolute inside it at a stable
	   width so its contents never reflow when the track changes. */
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
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 60%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 6%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 10%, transparent);
		/* The closed state for first paint, so an open-on-reload panel doesn't
		   flash before the $effect writes the transform inline. */
		transform: translateX(var(--right-panel-width));
	}

	.rightpanel-area.rightpanel-area--open {
		transform: translateX(0);
	}

	/* Stacked: too narrow for two panes, so the chat takes the main pane's
	   place, viewport-positioned onto exactly `.main-area`'s box so the swap
	   reads as the pane being replaced. Only while open: a closed panel stays
	   in its zero-width slot, clipped by `.app-shell`'s `overflow: hidden`.
	   The z-index clears the main pane's floating chrome (z-index 10). */
	.rightpanel-area.rightpanel-area--overlay {
		position: fixed;
		top: calc(var(--topbar-row-height) + var(--spacing-island));
		bottom: calc(var(--bottom-row-height) + var(--spacing-island));
		left: calc(var(--overlay-left) + var(--spacing-island));
		right: var(--spacing-island);
		width: auto;
		z-index: 11;
	}

	:global(:root.dark) .rightpanel-area {
		box-shadow:
			inset 0 1px 0 0 color-mix(in srgb, white 4%, transparent),
			0 1px 2px -1px color-mix(in srgb, black 40%, transparent),
			0 8px 24px -12px color-mix(in srgb, black 50%, transparent);
	}

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
