<script lang="ts">
import { buildPullRequestDeepLink } from "@revv/shared";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import Check from "phosphor-svelte/lib/Check";
import Desktop from "phosphor-svelte/lib/Desktop";
import LinkSimple from "phosphor-svelte/lib/LinkSimple";
import Moon from "phosphor-svelte/lib/Moon";
import SidebarSimple from "phosphor-svelte/lib/SidebarSimple";
import Sun from "phosphor-svelte/lib/Sun";
import { onDestroy } from "svelte";
import { toast } from "svelte-sonner";
import * as Tooltip from "$lib/components/ui/tooltip";
import { gsapFade, gsapPress, tokens } from "$lib/motion";
import { fetchOrgs } from "$lib/stores/orgs.svelte";
import {
  getIsLoading,
  getRepositories,
  getSelectedPr,
  getSelectedPrId,
} from "$lib/stores/prs.svelte";
import { getPrListSyncing, requestFullSync, requestSync } from "$lib/stores/sync.svelte";
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "$lib/stores/theme.svelte";
import { getTopbarSubtitle } from "$lib/stores/topbar.svelte";

interface Props {
  rightPanelOpen: boolean;
  onTogglePanel: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

let { rightPanelOpen, onTogglePanel, sidebarCollapsed, onToggleSidebar }: Props = $props();

const pr = $derived(getSelectedPr());
const repository = $derived(
  pr ? (getRepositories().find((candidate) => candidate.id === pr.repositoryId) ?? null) : null,
);
const selectedPrId = $derived(getSelectedPrId());
const theme = $derived(getThemePreference());
const topbarSubtitle = $derived(getTopbarSubtitle());
let linkCopied = $state(false);
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

onDestroy(() => {
  if (copyResetTimer) clearTimeout(copyResetTimer);
});

async function copyPrLink(): Promise<void> {
  if (!pr || !repository) return;
  try {
    const url = buildPullRequestDeepLink({
      githubHost: repository.githubHost,
      repositoryFullName: repository.fullName,
      number: pr.externalId,
    });
    await navigator.clipboard.writeText(url);
    linkCopied = true;
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      linkCopied = false;
      copyResetTimer = null;
    }, 1400);
  } catch {
    linkCopied = false;
    toast.error("Couldn’t copy the PR link.");
  }
}

// Combines direct-HTTP sync (`getIsLoading`) with SSE-driven
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
		<!-- One glyph; `fill` is the "panel is showing" state. Previously this
			 was an {#if} whose two branches imported the same icon under
			 different names, so the button never changed appearance. -->
		<SidebarSimple size={14} weight={sidebarCollapsed ? 'regular' : 'fill'} />
	</button>

	<!-- Left: app name / inline PR title when scrolled -->
	<div class="title-block">
		{#if pr}
			<div class="title-row">
				<span class="inline-title">
					<span class="pr-number">#{pr.externalId}</span>{pr.title}{#if topbarSubtitle}<span class="title-separator"> / </span><span class="title-subtitle">{topbarSubtitle}</span>{/if}
				</span>
				{#if repository}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<button
									{...props}
									class="copy-link-btn"
									onclick={copyPrLink}
									aria-label={linkCopied ? 'Link copied' : 'Copy PR link'}
									use:gsapPress
								>
									{#key linkCopied}
										<span in:gsapFade={{ duration: tokens.snap }} out:gsapFade={{ duration: tokens.snap }}>
											{#if linkCopied}<Check size={13} />{:else}<LinkSimple size={13} />{/if}
										</span>
									{/key}
								</button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="bottom" sideOffset={6}>
							{linkCopied ? 'Link copied' : 'Copy PR link'}
						</Tooltip.Content>
					</Tooltip.Root>
				{/if}
			</div>
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
			<ArrowsClockwise size={14} class={isSyncing ? 'motion-essential-spin' : ''} />
		</button>
		<button
			class="theme-btn"
			onclick={cycleTheme}
			aria-label={labels[theme]}
			title={labels[theme]}
		>
			{#if theme === 'light'}
				<Sun size={14} />
			{:else if theme === 'dark'}
				<Moon size={14} />
			{:else}
				<Desktop size={14} />
			{/if}
		</button>

		<button
			class="panel-btn"
			class:panel-btn--open={rightPanelOpen}
			onclick={onTogglePanel}
			aria-label={pr ? 'Toggle context panel (⌘⌥B)' : 'Chat panel is only available when reviewing a PR'}
			title={pr ? 'Toggle context panel (⌘⌥B)' : 'Chat panel is only available when reviewing a PR'}
			disabled={!pr}
		>
			<SidebarSimple size={14} mirrored weight={rightPanelOpen ? 'fill' : 'regular'} />
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
		min-width: 0;
	}

	.title-row {
		align-items: center;
		display: flex;
		gap: 6px;
		min-width: 0;
	}

	.copy-link-btn {
		align-items: center;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--color-text-muted);
		cursor: pointer;
		display: inline-flex;
		flex: 0 0 22px;
		height: 22px;
		justify-content: center;
		padding: 0;
		position: relative;
		width: 22px;
		z-index: 2;
	}

	.copy-link-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.copy-link-btn:focus-visible {
		box-shadow: 0 0 0 3px var(--color-input-focus-ring);
		outline: none;
	}

	.copy-link-btn :global(span) {
		align-items: center;
		display: inline-flex;
	}

	.copy-link-btn[aria-label="Link copied"] {
		color: var(--color-success);
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
