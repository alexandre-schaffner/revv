<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { PanelLeftClose, PanelLeftOpen, Settings } from '@lucide/svelte';
	import {
		getRepositories,
		getGroupedByRepo,
		getIsLoading,
	} from '$lib/stores/prs.svelte';
	import { requestSync } from '$lib/stores/ws.svelte';
	import { handleKey as handleNavKey, clearFocus, setFocusedId } from '$lib/stores/sidebar-nav.svelte';
	import { getPaletteOpen } from '$lib/stores/shortcuts.svelte';
	import { getActivePanel, enterScrollMode } from '$lib/stores/focus-mode.svelte';
	import { getAddRepoDialogOpen, setAddRepoDialogOpen } from '$lib/stores/sidebar.svelte';
	import SearchFilter from '$lib/components/sidebar/SearchFilter.svelte';
	import RepoGroup from '$lib/components/sidebar/RepoGroup.svelte';
	import AddRepoDialog from '$lib/components/sidebar/AddRepoDialog.svelte';

	interface Props {
		collapsed?: boolean;
		onToggle?: () => void;
	}

	let { collapsed = false, onToggle }: Props = $props();

	let addRepoOpen = $derived(getAddRepoDialogOpen());

	function handleSidebarClick(e: MouseEvent): void {
		const navEl = (e.target as HTMLElement).closest<HTMLElement>('[data-sidebar-nav]');
		if (navEl) {
			const id = navEl.getAttribute('data-sidebar-nav');
			if (id) setFocusedId(id);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		// Don't handle when sidebar is collapsed, palette is open, or modifier keys held
		if (collapsed) return;
		if (getPaletteOpen()) return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

		// Only process sidebar nav keys when the sidebar panel is active
		if (getActivePanel() !== 'sidebar') return;

		// 'v' enters diff scroll mode (viewport scrolling with j/k/d/u/G/gg)
		// Note: Space toggle is handled centrally in ReviewLayout to avoid double-fire.
		if (e.key === 'v') {
			e.preventDefault();
			enterScrollMode();
			return;
		}

		// '/' focuses the search input (vim search convention)
		if (e.key === '/') {
			e.preventDefault();
			const input = document.querySelector<HTMLInputElement>('.sidebar input');
			input?.focus();
			return;
		}

		if (handleNavKey(e)) {
			e.preventDefault();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!--
	Width is intentionally NOT set here — AppShell's grid column controls it.
	The toggle button is always the first item in the header so it stays
	anchored at the left edge and remains clickable even when collapsed to 40px.
-->
<div class="sidebar" role="none" onclick={handleSidebarClick}>
	<!-- Header — always visible -->
	<div class="sidebar-header">
		<!-- Toggle button: leftmost, always in the visible area -->
		<button
			class="icon-btn"
			onclick={onToggle}
			title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
			aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
		>
			{#if collapsed}
				<PanelLeftOpen size={14} />
			{:else}
				<PanelLeftClose size={14} />
			{/if}
		</button>

		<!-- Content clipped when collapsed -->
		{#if !collapsed}
			<span class="header-label">Pull Requests</span>
			<button
				class="icon-btn"
				onclick={requestSync}
				disabled={getIsLoading()}
				title="Sync PRs"
				aria-label="Sync pull requests"
			>
				<svg
					class="size-[14px] {getIsLoading() ? 'animate-spin' : ''}"
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
					<path d="M21 3v5h-5" />
					<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
					<path d="M8 16H3v5" />
				</svg>
			</button>
		{/if}
	</div>

	<!--
		Kept mounted (with display: contents) so RepoGroup / PrItem / DiffFileTree
		preserve their expand state across sidebar collapse/expand. When collapsed,
		the wrapper switches to display: none which hides without unmounting.
	-->
	<div class="sidebar-body" class:sidebar-body--hidden={collapsed} aria-hidden={collapsed}>
		<SearchFilter onAddRepo={() => setAddRepoDialogOpen(true)} />

		<div class="pr-list">
			{#if getRepositories().length === 0}
				<div class="empty-state">
					<svg class="empty-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
						<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
						<path d="M9 18c-4.51 2-5-2-7-2"/>
					</svg>
					<p class="empty-text">No repositories added</p>
					<button class="add-link" onclick={() => setAddRepoDialogOpen(true)}>
						Add a repository
					</button>
				</div>
			{:else}
				{#each getRepositories() as repo (repo.id)}
					{@const prs = getGroupedByRepo().get(repo.id) ?? []}
					<RepoGroup repository={repo} {prs} />
				{/each}
			{/if}
		</div>

		<div class="sidebar-footer">
			<button
				class="settings-btn"
				class:settings-btn--active={page.url.pathname === '/settings'}
				onclick={() => goto(page.url.pathname === '/settings' ? '/' : '/settings')}
			>
				<Settings size={14} />
				Settings
			</button>
		</div>
	</div>
</div>

<AddRepoDialog open={addRepoOpen} onClose={() => setAddRepoDialogOpen(false)} />

<style>
	.sidebar {
		display: flex;
		flex-direction: column;
		height: 100%;
		width: 100%; /* grid column controls actual width */
		background: var(--color-bg-secondary);
		overflow: hidden;
	}

	/* Tauri — traffic lights are in the topbar row above, no extra clearance needed */

	/* Header */
	.sidebar-header {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 0 6px;
		height: 40px;
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
		/* No min-width — must be happy at 40px */
	}

	.header-label {
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-text-muted);
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
	}

	/* Body wrapper — display:contents keeps children as direct flex-children of .sidebar
		 (so .pr-list still flex:1), while display:none when collapsed hides without unmounting. */
	.sidebar-body {
		display: contents;
	}

	.sidebar-body--hidden {
		display: none;
	}

	/* Icon buttons used in the header */
	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border: none;
		border-radius: 5px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		flex-shrink: 0; /* never squeeze away */
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.icon-btn:hover {
		background: var(--color-bg-elevated);
		color: var(--color-text-secondary);
	}

	.icon-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	/* PR list */
	.pr-list {
		flex: 1;
		overflow-y: auto;
		padding: 4px 0;
	}

	/* Empty state */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 32px 16px;
		text-align: center;
	}

	.empty-icon {
		width: 32px;
		height: 32px;
		color: var(--color-text-muted);
	}

	.empty-text {
		font-size: 11px;
		color: var(--color-text-muted);
		margin: 0;
	}

	.add-link {
		font-size: 11px;
		color: var(--color-accent);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
	}

	.add-link:hover {
		text-decoration: underline;
	}

	/* Footer */
	.sidebar-footer {
		border-top: 1px solid var(--color-border);
		padding: 8px;
		flex-shrink: 0;
	}

	.settings-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border-radius: 6px;
		border: none;
		background: transparent;
		font-size: 11px;
		color: var(--color-text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.settings-btn:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.settings-btn--active {
		background: var(--color-bg-elevated);
		color: var(--color-text-secondary);
	}
</style>
