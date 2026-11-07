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
import type { BareBinding, Command } from "$lib/stores/command-keys";
import { useCommands } from "$lib/stores/commands.svelte";
import { enterScrollMode, getActivePanel } from "$lib/stores/focus-mode.svelte";
import { getPrScrollPosition, setPrScrollPosition } from "$lib/stores/pr-view-state.svelte";
import { getRepoById, getRepositories } from "$lib/stores/repos.svelte";
import { getSelectedPr, getSelectedPrId, getSelectedRepo } from "$lib/stores/route.svelte";
import { getPaletteOpen } from "$lib/stores/shortcuts.svelte";
import {
  getAddRepoDialogOpen,
  getSidebarView,
  setAddRepoDialogOpen,
  setSidebarView,
} from "$lib/stores/sidebar.svelte";
import {
  clearFocus,
  focusFirst,
  focusLast,
  focusPr,
  getFocusedId,
  moveDown,
  moveUp,
  openFocused,
} from "$lib/stores/sidebar-nav.svelte";

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
const filesViewRepo = $derived(selectedPr ? getRepoById(selectedPr.repositoryId) : null);
// URL-driven by the +layout effect, so the column tracks the rail and
// deep links resolve.
const displayRepo = $derived(getSelectedRepo());
const hasRepos = $derived(getRepositories().length > 0);

// The PR list's scroll position is saved per selected PR, continuously, so it
// survives route changes. The file tree manages its own scroll.
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

const keysLive = (): boolean => !collapsed && !getPaletteOpen();
// Tree rows live in a shadow root, so a key's target is retargeted to its
// host, which is still inside the sidebar.
const inSidebar = (): HTMLElement | null => sidebarEl;
const inPrList = (): boolean => keysLive() && getActivePanel() === "sidebar" && view !== "files";
const inFileTree = (): boolean => keysLive() && getActivePanel() === "sidebar" && view === "files";

function sidebarKey(
  id: string,
  label: string,
  keys: BareBinding,
  when: () => boolean,
  run: () => void,
): Command {
  return { id: `sidebar:${id}`, label, keys, when, within: inSidebar, hidden: true, run };
}

useCommands([
  {
    id: "sidebar:search",
    label: "Search",
    keys: { bare: ["/"] },
    when: keysLive,
    hidden: true,
    run: () => {
      if (view === "files") filesView?.focusSearch();
      else prSearch?.focus();
    },
  },
  sidebarKey(
    "files-back",
    "Back to pull requests",
    { bare: ["Escape"] },
    inFileTree,
    returnToPrList,
  ),
  sidebarKey("files-down", "Next file", { bare: ["j"] }, inFileTree, () => filesView?.moveFocus(1)),
  sidebarKey("files-up", "Previous file", { bare: ["k"] }, inFileTree, () =>
    filesView?.moveFocus(-1),
  ),
  sidebarKey("files-open", "Open file", { bare: ["l"] }, inFileTree, () =>
    filesView?.openFocused(),
  ),
  sidebarKey("files-out", "Collapse folder", { bare: ["h"] }, inFileTree, () => {
    if (!filesView?.collapseOrParent()) returnToPrList();
  }),
  sidebarKey("prs-diff", "Scroll the diff", { bare: ["v"] }, inPrList, enterScrollMode),
  sidebarKey("prs-down", "Next pull request", { bare: ["j", "ArrowDown"] }, inPrList, moveDown),
  sidebarKey("prs-up", "Previous pull request", { bare: ["k", "ArrowUp"] }, inPrList, moveUp),
  sidebarKey("prs-open", "Open pull request", { bare: ["l", "ArrowRight"] }, inPrList, openFocused),
  sidebarKey(
    "prs-open-enter",
    "Open pull request",
    { bare: ["Enter"] },
    () => inPrList() && getFocusedId() !== null,
    openFocused,
  ),
  sidebarKey("prs-drop", "Drop the cursor", { bare: ["h", "ArrowLeft"] }, inPrList, clearFocus),
  sidebarKey(
    "prs-escape",
    "Drop the cursor",
    { bare: ["Escape"] },
    () => inPrList() && getFocusedId() !== null,
    clearFocus,
  ),
  sidebarKey("prs-first", "First pull request", { bare: ["g"], after: "g" }, inPrList, () => {
    focusFirst();
  }),
  sidebarKey("prs-last", "Last pull request", { bare: ["G"] }, inPrList, focusLast),
]);
</script>

<div class="sidebar" bind:this={sidebarEl}>
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

	<!-- Both panes stay mounted so PR-list state (scroll, focus, search)
	     persists across swipes. -->
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

	<div class="sidebar-fade" aria-hidden="true"></div>
</div>

<AddRepoDialog open={addRepoOpen} onOpenChange={setAddRepoDialogOpen} />

<style>
	.sidebar {
		position: relative; /* anchor for .sidebar-fade */
		display: flex;
		flex-direction: column;
		height: 100%;
		/* Full width even while the grid track is narrower (`.sidebar-area`
		   clips it), so the contents don't reflow per frame. */
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

	/* No fade on collapse: the parent's overflow does the reveal, and a fade
	   on top reads as two competing motions. */
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

	/* With aria-hidden, this stands in for `inert` on the off-screen pane. */
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
