<script lang="ts">
import RefreshCw from "phosphor-svelte/lib/ArrowsClockwise";
import Monitor from "phosphor-svelte/lib/Desktop";
import Moon from "phosphor-svelte/lib/Moon";
import PanelLeftClose from "phosphor-svelte/lib/SidebarSimple";
import PanelLeftOpen from "phosphor-svelte/lib/SidebarSimple";
import Sun from "phosphor-svelte/lib/Sun";
import { fetchOrgs } from "$lib/stores/orgs.svelte";
import { getIsLoading, getSelectedPr, getSelectedPrId } from "$lib/stores/prs.svelte";
import { getPrListSyncing } from "$lib/stores/sync.svelte";
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "$lib/stores/theme.svelte";
import { getTopbarSubtitle } from "$lib/stores/topbar.svelte";
import { requestFullSync, requestSync } from "$lib/stores/ws.svelte";
import FloatingTabs from "./FloatingTabs.svelte";

interface Props {
  rightPanelOpen: boolean;
  onTogglePanel: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

let { rightPanelOpen, onTogglePanel, sidebarCollapsed, onToggleSidebar }: Props = $props();

const pr = $derived(getSelectedPr());
const selectedPrId = $derived(getSelectedPrId());
const theme = $derived(getThemePreference());
const topbarSubtitle = $derived(getTopbarSubtitle());

// Combines direct-HTTP sync (`getIsLoading`) with WebSocket-driven
// PR-list sync (`getPrListSyncing`) so the spinner reflects any in-flight
// PR-list sync regardless of transport. Mirrors what Sidebar used to do.
const isSyncing = $derived(getIsLoading() || getPrListSyncing());

function handleSyncPrs(): void {
  if (selectedPrId) {
    requestFullSync(selectedPrId);
  } else {
    requestSync();
  }
  // Re-pull the org list — picks up newly-joined orgs and rotates
  // any signed avatar URLs without requiring re-auth.
  void fetchOrgs();
}
const cycle: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const labels: Record<ThemePreference, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

function cycleTheme() {
  setThemePreference(cycle[theme]);
}
</script>

<div class="topbar">
	<!-- Dedicated drag layer — sits behind interactive elements via z-index -->
	<div class="drag-layer" data-tauri-drag-region></div>

	<!-- Sidebar collapse toggle. In Tauri, absolutely positioned in the
		 traffic-light overlay row immediately to the right of the macOS
		 buttons. In browser mode, lives flush-left in the topbar's flex row. -->
	<button
		class="left-toggle-btn"
		onclick={onToggleSidebar}
		aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
		title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
	>
		{#if sidebarCollapsed}
			<PanelLeftOpen size={14} weight="fill" />
		{:else}
			<PanelLeftClose size={14} weight="fill" />
		{/if}
	</button>

	<!-- Left: app name / inline PR title when scrolled -->
	<div class="title-block">
		{#if pr}
			<span class="inline-title">
				<span class="pr-number">#{pr.externalId}</span>{pr.title}{#if topbarSubtitle}<span class="title-separator"> / </span><span class="title-subtitle">{topbarSubtitle}</span>{/if}
			</span>
		{:else}
			<span class="app-name">Revv</span>
		{/if}
	</div>

	<!-- Right: sync PRs + theme toggle + panel toggle -->
	<div class="panel-toggle-wrap">
		<button
			class="theme-btn"
			onclick={handleSyncPrs}
			disabled={isSyncing}
			aria-label="Sync pull requests"
			title="Sync pull requests"
		>
			<RefreshCw size={14} weight="fill" class={isSyncing ? 'motion-essential-spin' : ''} />
		</button>
		<button
			class="theme-btn"
			onclick={cycleTheme}
			aria-label={labels[theme]}
			title={labels[theme]}
		>
			{#if theme === 'light'}
				<Sun size={14} weight="fill" />
			{:else if theme === 'dark'}
				<Moon size={14} weight="fill" />
			{:else}
				<Monitor size={14} weight="fill" />
			{/if}
		</button>

		<button
			class="panel-btn"
			class:panel-btn--open={rightPanelOpen}
			onclick={onTogglePanel}
			aria-label={pr ? 'Toggle context panel (⌘R)' : 'Chat panel is only available when reviewing a PR'}
			title={pr ? 'Toggle context panel (⌘R)' : 'Chat panel is only available when reviewing a PR'}
			disabled={!pr}
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<rect width="18" height="18" x="3" y="3" rx="2" />
				<path d="M15 3v18" />
			</svg>
		</button>
	</div>
</div>

<style>
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 100%;
		padding: 0 var(--spacing-island);
		position: relative;
	}

	.drag-layer {
		position: absolute;
		inset: 0;
		z-index: 1;
	}

	.title-block {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 1px;
		min-width: 0;
		flex: 1;
	}

	.app-name {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.inline-title {
		font-size: 12px;
		font-weight: 400;
		color: var(--color-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pr-number {
		color: var(--color-text-muted);
		font-weight: 500;
		margin-right: var(--spacing-island-half);
	}

	.panel-toggle-wrap {
		display: flex;
		align-items: center;
		gap: var(--spacing-island-half);
		flex: 1;
		justify-content: flex-end;
	}

	/* In Tauri, position elements in the traffic-light zone */
	:global(html.tauri) .topbar {
		position: static;
	}

	:global(html.tauri) .panel-toggle-wrap {
		position: absolute;
		top: var(--spacing-island-half);
		right: var(--spacing-island);
		height: 22px;
		flex: none;
	}

	:global(html.tauri) .title-block {
		position: absolute;
		top: var(--spacing-island-half);
		left: 110px;
		right: 80px;
		height: 22px;
	}

	/* Sidebar collapse toggle. In browser mode, lives in the static flex row
	   at the left edge. In Tauri, anchored to the overlay row immediately
	   right of the macOS traffic lights (which occupy ~0–72px). */
	.left-toggle-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 100%;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		flex-shrink: 0;
		position: relative;
		z-index: 2;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.left-toggle-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	:global(html.tauri) .left-toggle-btn {
		position: absolute;
		top: var(--spacing-island-half);
		left: 78px;
		height: 22px;
	}

	:global(html.tauri) .theme-btn,
	:global(html.tauri) .panel-btn {
		height: 22px;
		width: 22px;
	}

	.theme-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		position: relative;
		z-index: 2;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.theme-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.theme-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.theme-btn:disabled:hover {
		background: transparent;
		color: var(--color-text-muted);
	}

	.panel-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		position: relative;
		z-index: 2;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.panel-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.panel-btn--open {
		color: var(--color-tree-active-text);
		background: var(--color-tree-active-bg);
	}

	.panel-btn--open:hover {
		background: var(--color-tree-active-bg);
		color: var(--color-tree-active-text);
	}

	.panel-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.panel-btn:disabled:hover {
		background: transparent;
		color: var(--color-text-muted);
	}

	.title-separator {
		color: var(--color-text-muted);
		opacity: 0.5;
		margin: 0 var(--spacing-island-half);
	}

	.title-subtitle {
		color: var(--color-text-muted);
		font-family: var(--font-mono, monospace);
		font-size: 11px;
	}
</style>
