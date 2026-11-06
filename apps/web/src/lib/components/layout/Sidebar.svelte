<script lang="ts">
import CaretLeft from "phosphor-svelte/lib/CaretLeft";
import Folder from "phosphor-svelte/lib/Folder";
import Plus from "phosphor-svelte/lib/Plus";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import AddRepoDialog from "$lib/components/sidebar/AddRepoDialog.svelte";
import AuthorFilter from "$lib/components/sidebar/AuthorFilter.svelte";
import ProjectArchiveList from "$lib/components/sidebar/ProjectArchiveList.svelte";
import ProjectHeader from "$lib/components/sidebar/ProjectHeader.svelte";
import ProjectPrList from "$lib/components/sidebar/ProjectPrList.svelte";
import SearchFilter from "$lib/components/sidebar/SearchFilter.svelte";
import SidebarFilesView from "$lib/components/sidebar/SidebarFilesView.svelte";
import { gsapFade, tokens } from "$lib/motion";
import { enterScrollMode, getActivePanel } from "$lib/stores/focus-mode.svelte";
import {
  getRepositories,
  getSelectedPr,
  getSelectedPrId,
  getSelectedRepo,
} from "$lib/stores/prs.svelte";
import { getPrScrollPosition, setPrScrollPosition } from "$lib/stores/review.svelte";
import { getPaletteOpen } from "$lib/stores/shortcuts.svelte";
import {
  getAddRepoDialogOpen,
  getSidebarView,
  setAddRepoDialogOpen,
  setSidebarView,
} from "$lib/stores/sidebar.svelte";
import { focusPr, handleKey as handleNavKey } from "$lib/stores/sidebar-nav.svelte";
import { isTextEditingKeyTarget } from "$lib/utils";

interface Props {
  collapsed?: boolean;
}

let { collapsed = false }: Props = $props();

let addRepoOpen = $derived(getAddRepoDialogOpen());
const selectedPrId = $derived(getSelectedPrId());
const view = $derived(getSidebarView());
// Breadcrumb back-button in files view derives the repo from the active
// PR so the header stays correct even before the new selectedRepoId
// effect resolves (cold load of /review/{prId} with empty repos cache).
const selectedPr = $derived(getSelectedPr());
const filesViewRepo = $derived(
  selectedPr ? (getRepositories().find((r) => r.id === selectedPr.repositoryId) ?? null) : null,
);
// Active project for the PR-list view header / lists. URL-driven by the
// +layout effect — single source of truth, so the column tracks the rail
// and deep-links resolve correctly.
const displayRepo = $derived(getSelectedRepo());
const hasRepos = $derived(getRepositories().length > 0);

// ── Per-PR scroll persistence (left pane) ────────────────────────────────
//
// The PR-list pane scrolls inside `.pr-list`; we anchor scroll position to
// the *currently-selected* PR. Switching to a new PR saves the outgoing
// PR's scrollTop and restores the incoming PR's. Continuous-write via
// onscroll keeps the value fresh across route changes / unmounts.
//
// The files-mode pane (PierreFileTree) manages its own scroll via the
// shadow-DOM tree library, so we don't try to drive it from here.
let prListEl = $state<HTMLElement | null>(null);
let suppressNextPrListScroll = false;

function handlePrListScroll(): void {
  if (suppressNextPrListScroll) {
    suppressNextPrListScroll = false;
    return;
  }
  if (!prListEl || !selectedPrId) return;
  setPrScrollPosition(selectedPrId, "sidebar", prListEl.scrollTop);
}

$effect(() => {
  // Restore the selected PR's saved scrollTop whenever it changes.
  const prId = selectedPrId;
  if (!prListEl) return;
  if (!prId) return;
  const saved = getPrScrollPosition(prId, "sidebar");
  suppressNextPrListScroll = true;
  prListEl.scrollTop = saved;
});

let sidebarEl = $state<HTMLElement | null>(null);
let prSearch = $state<ReturnType<typeof SearchFilter>>();
let filesView = $state<ReturnType<typeof SidebarFilesView>>();

function returnToPrList(): void {
  setSidebarView("prs");
  focusPr(getSelectedPrId());
}

function handleKeydown(e: KeyboardEvent) {
  if (collapsed) return;
  if (getPaletteOpen()) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTextEditingKeyTarget(e)) return;

  // '/' is the global "go to search" shortcut, resolved against the visible
  // pane. Sits above the active-panel guard so it also works from the diff
  // modes.
  if (e.key === "/") {
    e.preventDefault();
    if (view === "files") filesView?.focusSearch();
    else prSearch?.focus();
    return;
  }

  if (getActivePanel() !== "sidebar") return;
  // Tree rows live in a shadow root, so the event's target is retargeted to
  // its host — which is still inside the sidebar.
  if (!(e.target instanceof Node) || !sidebarEl?.contains(e.target)) return;

  if (view === "files") {
    if (e.key === "Escape") {
      e.preventDefault();
      returnToPrList();
      return;
    }
    const result = filesView?.navigate(e.key) ?? "ignored";
    if (result === "ignored") return;
    e.preventDefault();
    if (result === "exit") returnToPrList();
    return;
  }

  // 'v' enters diff scroll mode (viewport scrolling with j/k/d/u/G/gg)
  if (e.key === "v") {
    e.preventDefault();
    enterScrollMode();
    return;
  }

  if (handleNavKey(e)) {
    e.preventDefault();
  }
}
</script>

<svelte:window onkeydown={handleKeydown} />

<!--
	The project column. AppShell's grid sets the actual width — when collapsed,
	the column is 0 wide and hidden behind a CSS contraction. The rail sits to
	the left and is always visible.
-->
<div class="sidebar" bind:this={sidebarEl}>
	<!-- Header — back-breadcrumb in files mode, ProjectHeader in PR-list
	     mode. Drops to nothing when collapsed since the column is 0 wide.
	     Branches crossfade in sync with the pane slide below. -->
	<div
		class="sidebar-header"
		class:sidebar-header--hidden={collapsed}
		class:sidebar-header--project={view !== 'files'}
	>
		{#if view === 'files'}
			<button
				class="files-header header-branch"
				onclick={() => setSidebarView('prs')}
				title="Back to PR list (Esc)"
				aria-label="Back to PR list"
				in:gsapFade={{ duration: tokens.smooth }}
				out:gsapFade={{ duration: tokens.snap }}
			>
				<CaretLeft size={14} class="back-chevron" />
				{#if filesViewRepo}
					<RepoGradientAvatar
						fullName={filesViewRepo.fullName}
						ownerAvatarUrl={filesViewRepo.avatarUrl}
						size={14}
						radius={3}
						class="crumb-repo-avatar"
					/>
					<span class="crumb-repo" title={filesViewRepo.fullName}>{filesViewRepo.fullName}</span>
				{:else}
					<span class="crumb-repo">Pull request</span>
				{/if}
			</button>
		{:else}
			<div
				class="header-branch header-branch--projectheader"
				in:gsapFade={{ duration: tokens.smooth }}
				out:gsapFade={{ duration: tokens.snap }}
			>
				<ProjectHeader repo={displayRepo} />
			</div>
		{/if}
	</div>

	<!--
		Two-view drawer holding the PR list and the repo file-tree. Each pane is
		absolutely positioned so the body can host both side-by-side without
		fighting flex sizing. Swipe is driven by the parent's `--files` class:
		PRs translate(0) → translate(-100%) and Files translate(100%) →
		translate(0). Both panes stay mounted so PR-list state (scroll position,
		focus, search) persists across swipes.
	-->
	<div
		class="sidebar-body"
		class:sidebar-body--hidden={collapsed}
		class:sidebar-body--files={view === 'files'}
		aria-hidden={collapsed}
	>
		<div
			class="view-pane view-pane--prs"
			aria-hidden={view === 'files'}
		>
			<SearchFilter bind:this={prSearch}>
				{#snippet trailing()}
					{#if displayRepo}
						<AuthorFilter repoId={displayRepo.id} />
					{/if}
				{/snippet}
			</SearchFilter>

			<div class="pr-list" bind:this={prListEl} onscroll={handlePrListScroll}>
				{#if displayRepo}
					<ProjectPrList repoId={displayRepo.id} />
					<ProjectArchiveList repoId={displayRepo.id} />
				{:else if !hasRepos}
					<div class="empty-state">
						<Folder size={28} class="empty-icon" aria-hidden="true" />
						<p class="empty-text">No repositories added yet</p>
						<button class="add-link" onclick={() => setAddRepoDialogOpen(true)}>
							<Plus size={11} aria-hidden="true" />
							Add a repository
						</button>
					</div>
				{:else}
					<div class="empty-state">
						<p class="empty-text">Pick a project from the rail to see its pull requests.</p>
					</div>
				{/if}
			</div>
		</div>

		<div
			class="view-pane view-pane--files"
			aria-hidden={view !== 'files'}
		>
			{#if selectedPrId}
				<SidebarFilesView bind:this={filesView} />
			{/if}
		</div>
	</div>

	<!-- Bottom-edge fade: dissolves the PR list / file tree into the
	     userbar's bg-secondary so the bottom chrome strip reads as one
	     continuous band, with no hard clip between scrolling content and
	     the user menu below. -->
	<div class="sidebar-fade" aria-hidden="true"></div>
</div>

<AddRepoDialog open={addRepoOpen} onOpenChange={setAddRepoDialogOpen} />

<style>
	.sidebar {
		position: relative; /* anchor for .sidebar-fade */
		display: flex;
		flex-direction: column;
		height: 100%;
		/* Stable internal width — the grid track animates 0 ↔ sidebarWidth
		   during collapse/expand, but this element stays at full width so
		   its contents don't reflow per frame. `.sidebar-area`'s
		   overflow:hidden clips the overflow when the track is narrower.
		   During a live drag `--sidebar-width` updates per pointer event,
		   so the contents follow the cursor naturally. */
		width: var(--sidebar-width, 100%);
		background: var(--color-bg-secondary);
		overflow: hidden;
	}

	.sidebar-fade {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 48px;
		background: linear-gradient(to bottom, transparent 0%, color-mix(in srgb, var(--color-bg-secondary) 90%, transparent) 80%, var(--color-bg-secondary) 100%);
		pointer-events: none;
		z-index: 5;
	}

	/* position:relative anchors the two stacked .header-branch children so
	   they crossfade in place during the view-toggle. No opacity/transform
	   transition on the collapse toggle — the sidebar stays at full
	   --sidebar-width and the parent's overflow:hidden does the reveal;
	   layering a fade on top reads as two competing motions. Visibility is
	   deferred off so the content lingers through the full collapse, then
	   drops out for tab focus once the panel is actually closed. */
	.sidebar-header {
		position: relative;
		min-height: 48px;
		flex-shrink: 0;
		visibility: visible;
		transition: visibility 0s linear 0s;
	}

	.sidebar-header--project {
		min-height: 84px;
	}

	.header-branch {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		min-width: 0;
	}

	.header-branch--projectheader {
		align-items: stretch;
	}

	.header-branch--projectheader :global(.project-header) {
		width: 100%;
	}

	.sidebar-header--hidden {
		visibility: hidden;
		transition: visibility 0s linear var(--duration-smooth);
	}

	/* Files-view breadcrumb back-button. Stretches the full content row
	   so clicking anywhere on the row swipes back. */
	.files-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
		border: none;
		border-radius: 5px;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		text-align: left;
		font-size: 12px;
		transition: background-color var(--duration-snap);
	}

	.files-header:hover {
		background: var(--color-bg-elevated);
	}

	.files-header :global(.back-chevron) {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	:global(.crumb-repo-icon) {
		width: 13px;
		height: 13px;
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	:global(.crumb-repo-avatar) {
		flex-shrink: 0;
	}

	.crumb-repo {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-primary);
	}

	/* Body wrapper — provides the positioning context for the two stacked
	   panes. Each pane is absolutely positioned and animates its own
	   translateX so we never have to fight flex sizing across a 200%-wide
	   track. The body's overflow:hidden clips the off-screen pane.
	   Collapse-toggle handling matches .sidebar-header above. */
	.sidebar-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		position: relative;
		contain: layout paint;
		visibility: visible;
		transition: visibility 0s linear 0s;
	}

	.sidebar-body--hidden {
		visibility: hidden;
		pointer-events: none;
		transition: visibility 0s linear var(--duration-smooth);
	}

	.view-pane {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		contain: layout paint;
		transition: transform var(--duration-smooth) var(--ease-out-expo);
		will-change: transform;
	}

	.view-pane--prs {
		transform: translateX(0);
	}

	.view-pane--files {
		transform: translateX(100%);
	}

	.sidebar-body--files .view-pane--prs {
		transform: translateX(-100%);
	}

	.sidebar-body--files .view-pane--files {
		transform: translateX(0);
	}

	/* Block stray pointer events on whichever pane is off-screen. Combined
	   with aria-hidden this is the equivalent of `inert` without the
	   attribute-handling quirks that previously interacted badly with
	   the layout. */
	.sidebar-body:not(.sidebar-body--files) .view-pane--files,
	.sidebar-body--files .view-pane--prs {
		pointer-events: none;
	}

	/* PR list — bottom padding equals .sidebar-fade height so the last row
	   can scroll past the fade region; without it the fade would always
	   half-cover the last PR. */
	.pr-list {
		flex: 1;
		overflow-y: auto;
		padding: var(--spacing-island-half) 0 48px;
	}

	/* Empty state */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 40px 24px;
		text-align: center;
	}

	:global(.empty-icon) {
		color: var(--color-text-muted);
	}

	.empty-text {
		font-size: 12px;
		color: var(--color-text-muted);
		margin: 0;
		line-height: 1.5;
	}

	.add-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		border: none;
		border-radius: 6px;
		background: var(--color-bg-elevated);
		color: var(--color-accent, var(--color-text-secondary));
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.add-link:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}
</style>
