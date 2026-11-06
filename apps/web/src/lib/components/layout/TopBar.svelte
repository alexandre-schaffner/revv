<script lang="ts">
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import Check from "phosphor-svelte/lib/Check";
import LinkSimple from "phosphor-svelte/lib/LinkSimple";
import SidebarSimple from "phosphor-svelte/lib/SidebarSimple";
import ThemeIcon from "$lib/components/shared/ThemeIcon.svelte";
import { cycleThemePreference, themePreferenceLabel } from "$lib/components/shared/theme-cycle";
import * as Tooltip from "$lib/components/ui/tooltip";
import { gsapPop, gsapPress, tokens } from "$lib/motion";
import { copySelectedPrLink, getPrLinkCopied } from "$lib/stores/pr-link.svelte";
import { getRepoById } from "$lib/stores/repos.svelte";
import { getSelectedPr, getSelectedPrId } from "$lib/stores/route.svelte";
import { getPrListSyncing, requestFullSync, requestSync } from "$lib/stores/sync.svelte";

interface Props {
  /** Appended to the PR title, e.g. the file the diff has scrolled to. */
  subtitle: string | null;
  rightPanelOpen: boolean;
  onTogglePanel: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

let { subtitle, rightPanelOpen, onTogglePanel, sidebarCollapsed, onToggleSidebar }: Props =
  $props();

const pr = $derived(getSelectedPr());
const repository = $derived(pr ? getRepoById(pr.repositoryId) : null);
const selectedPrId = $derived(getSelectedPrId());
const linkCopied = $derived(getPrLinkCopied());

const isSyncing = $derived(getPrListSyncing());

function handleSyncPrs(): void {
  if (selectedPrId) {
    requestFullSync(selectedPrId);
  } else {
    void requestSync();
  }
}
</script>

<div class="topbar">
	<div class="drag-layer" data-tauri-drag-region></div>

	<button
		class="left-toggle-btn"
		onclick={onToggleSidebar}
		aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
		title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
	>
		<!-- One glyph; `fill` is the "panel is showing" state. -->
		<SidebarSimple size={14} weight={sidebarCollapsed ? 'regular' : 'fill'} />
	</button>

	<div class="title-block">
		{#if pr}
			<div class="title-row">
				<span class="inline-title">
					<span class="pr-number">#{pr.externalId}</span>{pr.title}{#if subtitle}<span class="title-separator"> / </span><span class="title-subtitle">{subtitle}</span>{/if}
				</span>
				{#if repository}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<button
									{...props}
									class="copy-link-btn"
									onclick={() => void copySelectedPrLink()}
									aria-label={linkCopied ? 'Link copied' : 'Copy PR link (\u21e7\u2318C)'}
									use:gsapPress
								>
									{#key linkCopied}
										<span
											class="copy-link-icon"
											class:copied={linkCopied}
											in:gsapPop={{ duration: tokens.quick }}
											out:gsapPop={{ duration: tokens.instant }}
										>
											{#if linkCopied}<Check size={13} />{:else}<LinkSimple size={13} />{/if}
										</span>
									{/key}
								</button>
							{/snippet}
						</Tooltip.Trigger>
						<!-- Deliberately static: the tooltip is open under the cursor when
						     the click lands, so swapping its text mid-hover resizes and
						     re-centers the surface. The icon carries the confirmation. -->
						<Tooltip.Content side="bottom" sideOffset={6}>
							Copy PR link (&#x21e7;&#x2318;C)
						</Tooltip.Content>
					</Tooltip.Root>
				{/if}
			</div>
		{:else}
			<span class="app-name">Revv</span>
		{/if}
	</div>

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
			onclick={cycleThemePreference}
			aria-label={themePreferenceLabel()}
			title={themePreferenceLabel()}
		>
			<ThemeIcon size={14} />
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

	/* Stacked so the outgoing and incoming glyph crossfade in place rather
	   than competing for the button's 22px of layout — see `gsapPop`. */
	.copy-link-icon {
		align-items: center;
		display: inline-flex;
		inset: 0;
		justify-content: center;
		position: absolute;
	}

	/* On the glyph, not the button: the success color then crossfades with
	   the icon instead of snapping both frames green at once. */
	.copy-link-icon.copied {
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

	/* In Tauri, anchored right of the macOS traffic lights (~0–72px). */
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
