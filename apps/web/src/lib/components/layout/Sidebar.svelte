<script lang="ts">
import {
  Archive,
  ChevronLeft,
  GitPullRequest,
  GitPullRequestArrow,
  PanelLeftOpen,
} from "@lucide/svelte";
import { slide } from "svelte/transition";
import AddRepoDialog from "$lib/components/sidebar/AddRepoDialog.svelte";
import OrgSwitcher from "$lib/components/sidebar/OrgSwitcher.svelte";
import RepoGroup from "$lib/components/sidebar/RepoGroup.svelte";
import SearchFilter from "$lib/components/sidebar/SearchFilter.svelte";
import SidebarFilesView from "$lib/components/sidebar/SidebarFilesView.svelte";
import UserMenu from "$lib/components/sidebar/UserMenu.svelte";
import { enterScrollMode, getActivePanel } from "$lib/stores/focus-mode.svelte";
import {
  getArchivedByRepo,
  getArchivedPrs,
  getGroupedByRepo,
  getNeedsYourReview,
  getNeedsYourReviewByRepo,
  getRepositories,
  getSelectedPr,
  getSelectedPrId,
  getVisibleRepositories,
} from "$lib/stores/prs.svelte";
import { getPrScrollPosition, setPrScrollPosition } from "$lib/stores/review.svelte";
import { getPaletteOpen } from "$lib/stores/shortcuts.svelte";
import {
  getAddRepoDialogOpen,
  getSidebarView,
  setAddRepoDialogOpen,
  setSidebarView,
  toggleSidebar,
} from "$lib/stores/sidebar.svelte";
import {
  clearFocus,
  handleKey as handleNavKey,
  setFocusedId,
} from "$lib/stores/sidebar-nav.svelte";

interface Props {
  collapsed?: boolean;
}

let { collapsed = false }: Props = $props();

let archiveExpanded = $state(
  typeof localStorage !== "undefined"
    ? localStorage.getItem("sidebar-archive-expanded") !== "false"
    : false,
);
function toggleArchive() {
  archiveExpanded = !archiveExpanded;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("sidebar-archive-expanded", String(archiveExpanded));
  }
}

let addRepoOpen = $derived(getAddRepoDialogOpen());
const selectedPrId = $derived(getSelectedPrId());
const view = $derived(getSidebarView());
// Selected PR + its repo, used to drive the breadcrumb back-button in
// files view. Both are nullable: PR-list mode renders `null` for both,
// and even in files view the stores can briefly disagree during a swap.
const selectedPr = $derived(getSelectedPr());
const selectedRepo = $derived(
  selectedPr ? (getRepositories().find((r) => r.id === selectedPr.repositoryId) ?? null) : null,
);

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
  const id = selectedPrId;
  if (!prListEl || !id) return;
  const saved = getPrScrollPosition(id, "sidebar");
  suppressNextPrListScroll = true;
  prListEl.scrollTop = saved;
});

function handleSidebarClick(e: MouseEvent): void {
  const navEl = (e.target as HTMLElement).closest<HTMLElement>("[data-sidebar-nav]");
  if (navEl) {
    const id = navEl.getAttribute("data-sidebar-nav");
    if (id) setFocusedId(id);
  }
}

// When a row inside @pierre/trees' shadow root has focus,
// document.activeElement returns the shadow host — not the button.
// Traverse shadow roots until we reach the real focused element.
function getDeepActiveElement(): HTMLElement | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el instanceof HTMLElement ? el : null;
}

// Tree rows live inside a shadow root on a child of .pierre-tree-host.
// document.querySelector cannot pierce shadow DOM, so walk the host's
// children and query each child's shadow root directly.
function findFirstFileTreeRow(): HTMLElement | null {
  const treeHost = document.querySelector<HTMLElement>(".view-pane--files .pierre-tree-host");
  if (!treeHost) return null;
  for (const child of Array.from(treeHost.children)) {
    const row = (child as HTMLElement).shadowRoot?.querySelector<HTMLElement>('[data-type="item"]');
    if (row) return row;
  }
  return null;
}

// Switch to the PR list and restore the keyboard cursor to the selected PR.
// Both panes are always mounted (CSS translate, not unmount), so the PR nav
// element is queryable even while off-screen. PR nav IDs are
// `${prefix}:${pr.id}` where prefix is 'pr' or 'review' — query by suffix
// to avoid hard-coding the section prefix.
function returnToPrList(): void {
  setSidebarView("prs");
  const prId = getSelectedPrId();
  if (prId) {
    const prNavEl = document.querySelector<HTMLElement>(`[data-sidebar-nav$=":${prId}"]`);
    const navId = prNavEl?.getAttribute("data-sidebar-nav");
    if (navId) {
      setFocusedId(navId);
      return;
    }
  }
  clearFocus();
}

function handleKeydown(e: KeyboardEvent) {
  // Don't handle when sidebar is collapsed, palette is open, or modifier keys held
  if (collapsed) return;
  if (getPaletteOpen()) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

  // '/' is the global "go to search" shortcut. Resolved against the
  // visible pane — PR search in 'prs' view, file search in 'files'
  // view — instead of the previous `.sidebar input` lookup, which
  // always landed on the first DOM input (PR search) even while the
  // files pane was the one on screen. Sits above the active-panel
  // guard so it also works from diff-scroll / diff-line modes.
  if (e.key === "/") {
    e.preventDefault();
    const selector = view === "files" ? ".view-pane--files input" : ".view-pane--prs input";
    const input = document.querySelector<HTMLInputElement>(selector);
    input?.focus();
    input?.select();
    return;
  }

  // Only process sidebar nav keys when the sidebar panel is active
  if (getActivePanel() !== "sidebar") return;

  // In files view we delegate movement to @pierre/trees' built-in
  // keyboard handler, which lives on the row buttons inside the tree's
  // shadow root. We:
  //   - Escape always swipes back to the PR list
  //   - h collapses an open directory (ArrowLeft), navigates to parent
  //     for a nested item (ArrowLeft), and only swipes back to the PR
  //     list when focus is on a root-level item that has nowhere to go
  //   - l on a directory: ArrowRight (expand or step into first child)
  //     l on a file: click() to select and open in the main pane
  //       (ArrowRight on a leaf just calls focusNextItem in the library,
  //        never triggering onSelectionChange)
  //   - j / k: ArrowDown / ArrowUp dispatched on the focused row button
  if (view === "files") {
    if (e.key === "Escape") {
      e.preventDefault();
      returnToPrList();
      return;
    }

    if (e.key === "h") {
      e.preventDefault();
      const target = getDeepActiveElement();
      // Use data-item-parent-path (not a slash-check on data-item-path)
      // to detect root-level items. Flattened directory rows can have
      // paths like "src/components" even when they sit at the tree root,
      // making a "/" test unreliable. data-item-parent-path is absent
      // (null) on root-level items and set to the parent path otherwise.
      const isOpenDir = target?.getAttribute("aria-expanded") === "true";
      const hasParent = target?.getAttribute("data-item-parent-path") != null;
      if (isOpenDir || hasParent) {
        // Can still navigate in the tree: collapse open dir or go up.
        const rowTarget =
          target?.closest<HTMLElement>('[data-type="item"]') ?? findFirstFileTreeRow();
        if (rowTarget) {
          if (rowTarget !== target) rowTarget.focus();
          rowTarget.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "ArrowLeft",
              code: "ArrowLeft",
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        return;
      }
      // Root-level closed item (or nothing focused) — go back to PRs.
      returnToPrList();
      return;
    }

    if (e.key === "l") {
      e.preventDefault();
      const target = getDeepActiveElement();
      const rowTarget =
        target?.closest<HTMLElement>('[data-type="item"]') ?? findFirstFileTreeRow();
      if (!rowTarget) return;
      if (rowTarget !== target) rowTarget.focus();
      if (rowTarget.getAttribute("data-item-type") === "file") {
        // File: click to select and open in the main pane.
        rowTarget.click();
      } else {
        // Directory: ArrowRight expands a closed dir or steps into
        // the first child of an open dir.
        rowTarget.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      return;
    }

    const arrowKey = e.key === "j" ? "ArrowDown" : e.key === "k" ? "ArrowUp" : null;
    if (arrowKey === null) return;

    e.preventDefault();
    // document.activeElement returns the shadow host when focus is
    // inside the tree's shadow root — traverse into the shadow chain
    // to get the actual focused row button.
    const target = getDeepActiveElement();
    // If the focused element is already a tree row use it; otherwise
    // fall back to the first visible row inside the shadow DOM.
    const rowTarget = target?.closest<HTMLElement>('[data-type="item"]') ?? findFirstFileTreeRow();
    if (!rowTarget) return;
    if (rowTarget !== target) rowTarget.focus();
    rowTarget.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: arrowKey,
        code: arrowKey,
        bubbles: true,
        cancelable: true,
      }),
    );
    return;
  }

  // 'v' enters diff scroll mode (viewport scrolling with j/k/d/u/G/gg)
  // Note: Space toggle is handled centrally in ReviewLayout to avoid double-fire.
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
	Width is intentionally NOT set here — AppShell's grid column controls it.
	The toggle button is always the first item in the header so it stays
	anchored at the left edge and remains clickable even when collapsed to 40px.
-->
<div class="sidebar" role="none" onclick={handleSidebarClick}>
	<!-- Header — keeps the org avatar visible at all times so the user
		 always knows the active scope, even when the sidebar is collapsed.
		 Expand affordance lives in the topbar next to the macOS traffic lights. -->
	<div class="sidebar-header" class:sidebar-header--collapsed={collapsed}>
		{#if !collapsed && view === 'files'}
			<button
				class="files-header"
				onclick={() => setSidebarView('prs')}
				title="Back to PR list (Esc)"
				aria-label="Back to PR list"
			>
				<ChevronLeft size={14} class="back-chevron" />
				{#if selectedRepo}
					{#if selectedRepo.avatarUrl}
						<img src={selectedRepo.avatarUrl} alt="" class="crumb-repo-avatar" referrerpolicy="no-referrer" />
					{:else}
						<svg
							class="crumb-repo-icon"
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 16 16"
							fill="currentColor"
							aria-hidden="true"
						>
							<path
								d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.75.75 0 0 1-.4-.2Z"
							/>
						</svg>
					{/if}
					<span class="crumb-repo" title={selectedRepo.fullName}>{selectedRepo.fullName}</span>
				{:else}
					<span class="crumb-repo">Pull request</span>
				{/if}
			</button>
		{:else if collapsed}
			<div class="collapsed-toggle-wrap">
				<OrgSwitcher {collapsed} />
				<button class="collapsed-expand-btn" onclick={toggleSidebar} title="Expand sidebar" aria-label="Expand sidebar">
					<PanelLeftOpen size={14} />
				</button>
			</div>
		{:else}
			<OrgSwitcher {collapsed} />
		{/if}
	</div>

	<!--
		Two-view drawer holding the PR list and the repo file-tree. Each pane is
		absolutely positioned so the body can host both side-by-side without
		fighting flex sizing. Swipe is driven by the parent's `--files` class:
		PRs translate(0) → translate(-100%) and Files translate(100%) →
		translate(0). Both panes stay mounted so PR-list state (scroll position,
		expanded repo groups, focus) persists across swipes.
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
				<SearchFilter onAddRepo={() => setAddRepoDialogOpen(true)} />

				<div class="pr-list" bind:this={prListEl} onscroll={handlePrListScroll}>
					{#if getNeedsYourReview().length > 0}
						<div class="needs-review-section">
							<div class="section-header">
								<GitPullRequestArrow size={11} />
								<span>Needs Your Review</span>
								<span class="section-count">{getNeedsYourReview().length}</span>
							</div>
							<div class="section-items">
								{#each getVisibleRepositories().filter(r => (getNeedsYourReviewByRepo().get(r.id) ?? []).length > 0) as repo (repo.id)}
									{@const prs = getNeedsYourReviewByRepo().get(repo.id) ?? []}
									<RepoGroup repository={repo} {prs} navPrefix="review" />
								{/each}
							</div>
						</div>
					{/if}
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
				{:else if getVisibleRepositories().length === 0}
					<div class="empty-state">
						<svg class="empty-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
							<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
							<path d="M9 18c-4.51 2-5-2-7-2"/>
						</svg>
						<p class="empty-text">No repositories in this workspace</p>
					</div>
				{:else}
						{@const allOpenPrsCount = getVisibleRepositories().reduce((sum, repo) => {
							const reviewIds = new Set((getNeedsYourReviewByRepo().get(repo.id) ?? []).map(p => p.id));
							return sum + (getGroupedByRepo().get(repo.id) ?? []).filter(p => !reviewIds.has(p.id)).length;
						}, 0)}
						<div class="section-header">
							<GitPullRequest size={11} />
							<span>All Open PRs</span>
							<span class="section-count">{allOpenPrsCount}</span>
						</div>
					{#each getVisibleRepositories() as repo (repo.id)}
						{@const reviewIds = new Set((getNeedsYourReviewByRepo().get(repo.id) ?? []).map(p => p.id))}
						{@const prs = (getGroupedByRepo().get(repo.id) ?? []).filter(p => !reviewIds.has(p.id))}
						<RepoGroup repository={repo} {prs} />
					{/each}

					{#if getArchivedPrs().length > 0}
						<div class="archive-section">
							<button class="archive-header" onclick={toggleArchive} aria-expanded={archiveExpanded}>
								<svg
									class="h-3 w-3 shrink-0 text-text-muted transition-transform duration-snap ease-out-expo {archiveExpanded ? 'rotate-90' : ''}"
									xmlns="http://www.w3.org/2000/svg"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
								>
									<path d="m9 18 6-6-6-6" />
								</svg>
								<Archive size={11} class="text-text-muted" />
								<span>Archive</span>
								<span class="section-count">{getArchivedPrs().length}</span>
							</button>
							{#if archiveExpanded}
								<div transition:slide={{ duration: 220 }}>
									{#each getVisibleRepositories().filter(r => (getArchivedByRepo().get(r.id) ?? []).length > 0) as repo (repo.id)}
										{@const archivedForRepo = getArchivedByRepo().get(repo.id) ?? []}
										<RepoGroup repository={repo} prs={archivedForRepo} navPrefix="archive" variant="archived" />
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				{/if}
				</div>
		</div>

		<div
			class="view-pane view-pane--files"
			aria-hidden={view !== 'files'}
		>
			{#if selectedPrId}
				<SidebarFilesView />
			{/if}
		</div>
	</div>

	<!--
		Footer lives outside .sidebar-body so the user menu stays visible
		and clickable even when the sidebar is collapsed (body is display:none).
	-->
	<div class="sidebar-footer" class:sidebar-footer--collapsed={collapsed}>
		<UserMenu {collapsed} />
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
		padding: 4px 6px;
		height: 48px;
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
		/* No min-width — must be happy at 40px */
		transition:
			height var(--duration-smooth) var(--ease-out-expo),
			padding var(--duration-smooth) var(--ease-out-expo);
	}

	.sidebar-header--collapsed {
		justify-content: center;
		padding: 0;
		height: 40px;
	}

	/* Files-view breadcrumb back-button. Replaces the org switcher + refresh
		 in the top header when the sidebar is in 'files' view. Stretches the
		 full content row (40px high, gap-respecting padding) so clicking
		 anywhere on the row swipes back. Scoped styles must live here, with
		 the markup. */
	.files-header {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 0 6px;
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

	.crumb-repo-icon {
		width: 13px;
		height: 13px;
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.crumb-repo-avatar {
		width: 14px;
		height: 14px;
		border-radius: 3px;
		object-fit: cover;
		flex-shrink: 0;
	}

	.collapsed-toggle-wrap {
		position: relative;
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.collapsed-expand-btn {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: var(--color-bg-elevated);
		border-radius: 4px;
		color: var(--color-text-secondary);
		cursor: pointer;
		opacity: 0;
		transition: opacity var(--duration-snap);
	}

	.collapsed-toggle-wrap:hover .collapsed-expand-btn {
		opacity: 1;
	}

	.collapsed-toggle-wrap:hover :global(.org-trigger--collapsed) {
		opacity: 0;
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
		 track (an earlier attempt that miscompiled and zeroed the visible
		 PR list after a swipe-back). The body's overflow:hidden clips the
		 off-screen pane. */
	/* .sidebar-body — base (expanded / expand direction)
	   60ms delay on content means column leads the reveal */
	.sidebar-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		position: relative;
		opacity: 1;
		visibility: visible;
		transform: translateX(0);
		will-change: transform, opacity;
		transition:
			opacity var(--duration-quick) var(--ease-out-expo) 60ms,
			transform var(--duration-quick) var(--ease-out-expo) 60ms,
			visibility 0s linear 0s;
	}

	/* .sidebar-body--hidden — collapse direction
	   content fades out and slides left quickly (120ms),
	   visibility hides after opacity reaches 0 (clears tab order) */
	.sidebar-body--hidden {
		opacity: 0;
		visibility: hidden;
		transform: translateX(-12px);
		pointer-events: none;
		transition:
			opacity var(--duration-quick) var(--ease-soft),
			transform var(--duration-quick) var(--ease-soft),
			visibility 0s linear var(--duration-quick);
	}

	/* Each pane fills the body and translates horizontally. Default state
		 ('prs' view): PRs sit at translateX(0) (visible), Files at
		 translateX(100%) (off-screen right). Toggle the parent's
		 `--files` modifier to swap. */
	.view-pane {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		transition: transform 250ms var(--ease-out-expo);
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

	/* PR list */
	.pr-list {
		flex: 1;
		overflow-y: auto;
		padding: 4px 0;
	}

	.needs-review-section {
		border-bottom: 1px solid var(--color-border);
		padding-bottom: 4px;
		margin-bottom: 4px;
	}

	.section-header {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 6px 12px 4px;
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.section-count {
		margin-left: auto;
		border-radius: 9999px;
		background: var(--color-bg-elevated);
		padding: 0 6px;
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
	}

	.section-items {
		display: flex;
		flex-direction: column;
		gap: 2px;
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

	.archive-section {
		border-top: 1px solid var(--color-border);
		padding-top: 4px;
		margin-top: 4px;
	}

	.archive-header {
		display: flex;
		align-items: center;
		gap: 5px;
		width: 100%;
		padding: 6px 12px 4px;
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--color-text-muted);
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
	}

	.archive-header:hover {
		color: var(--color-text-secondary);
	}

	/* Footer — kept outside .sidebar-body so Settings is reachable while collapsed.
		 margin-top:auto pins it to the bottom even when .pr-list is hidden (collapsed). */
	.sidebar-footer {
		display: flex;
		align-items: center;
		margin-top: auto;
		border-top: 1px solid var(--color-border);
		padding: 6px;
		flex-shrink: 0;
		transition:
			padding var(--duration-smooth) var(--ease-out-expo),
			height var(--duration-smooth) var(--ease-out-expo);
	}

	.sidebar-footer--collapsed {
		padding: 6px 0;
		height: 40px; /* matches BottomBar grid row */
	}
</style>
