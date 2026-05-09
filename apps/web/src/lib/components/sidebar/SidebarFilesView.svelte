<script lang="ts">
	import type { GitStatusEntry } from '@pierre/trees';
	import {
		getSidebarView,
		getFileSearchQuery,
		setFileSearchQuery,
	} from '$lib/stores/sidebar.svelte';
	import {
		getReviewFiles,
		getRepoTreePaths,
		getRepoTreeStatus,
		getRepoTreeError,
	getActiveFilePath,
	setActiveFilePath,
	getActiveTab,
	setActiveTab,
	getIsLoadingFiles,
	loadRepoFile,
	clearRepoFile,
	requestDiffScrollReset,
} from '$lib/stores/review.svelte';
	import { getSelectedPrId } from '$lib/stores/prs.svelte';
	import { enterScrollMode, getActivePanel } from '$lib/stores/focus-mode.svelte';
	import { getSettings } from '$lib/stores/settings.svelte';
	import PierreFileTree from './PierreFileTree.svelte';
	import SidebarFilesSearch from './SidebarFilesSearch.svelte';
	// User-controlled scope — falls back to 'all' until settings hydrate.
	const fileTreeScope = $derived(getSettings()?.fileTreeScope ?? 'all');
	const reviewFiles = $derived(getReviewFiles());
	// Source-of-truth path list handed to the tree. In `'all'` mode this is
	// the full repo listing from `git ls-tree`; in `'changed'` mode we
	// substitute the PR's diff files so the tree only shows what's modified.
	// Both branches reuse the same git-status decoration map below.
	const repoPaths = $derived.by((): string[] => {
		if (fileTreeScope === 'changed') {
			return reviewFiles.map((f) => f.path);
		}
		return getRepoTreePaths();
	});
	// In 'changed' mode the path source is `reviewFiles`, which is fetched by
	// the review page's effect. While that fetch is in flight (e.g. right
	// after a Cmd+P jump from one PR to another) `reviewFiles` has been
	// cleared by `clearReviewFiles()` and the new diff hasn't arrived yet —
	// surface that as `'loading'` so the placeholder renders instead of an
	// empty (or worse, stale) tree the user can mis-click. Once the fetch
	// resolves we settle to `'ready'`.
	const status = $derived.by(() => {
		if (fileTreeScope === 'changed') {
			return getIsLoadingFiles() ? 'loading' : 'ready';
		}
		return getRepoTreeStatus();
	});
	const activePath = $derived(getActiveFilePath());
	// Auto-focus the tree's first row whenever this view becomes active so
	// the library's built-in arrow-key navigation has somewhere to start.
	// PierreFileTree only honors `shouldFocus` while it transitions
	// false → true, so toggling it back to false on swipe-back makes the
	// next swipe-in re-trigger focus.
	const shouldFocus = $derived(getSidebarView() === 'files');

	// Goes false → true every time the user returns to the sidebar panel
	// from a diff mode (Escape / Space / h). Used by PierreFileTree to
	// re-focus the active row on panel return — `shouldFocus` only fires on
	// the view-switch path (PR list → files) and stays true throughout diff
	// navigation, so it can't cover the panel-return path.
	const panelActive = $derived(getActivePanel() === 'sidebar');

	// Set of every repo path so we can tell files (in the set) apart from
	// directories (not in the set — git ls-tree only returns blob entries).
	// Cheaper and more reliable than asking the tree's controller about the
	// item kind, which we can't do from this layer.
	const filePaths = $derived(new Set(repoPaths));
	// Set of PR-changed paths. Used purely for "should we switch the main
	// pane to the Diff tab?" — clicking an unchanged file still updates
	// `activeFilePath`, but staying on the active tab feels less jumpy
	// than yanking the user out of e.g. Walkthrough into an empty diff.
	const changedFileSet = $derived(new Set(reviewFiles.map((f) => f.path)));

	// Per-file additions + deletions for the line-count badge on the right
	// side of each tree row. Both scopes show stats — in 'all' mode only
	// changed files have entries (unchanged files get nothing); in 'changed'
	// mode every visible row is in the PR diff so every row gets a badge.
	const statsMap = $derived.by((): Map<string, { additions: number; deletions: number }> => {
		const m = new Map<string, { additions: number; deletions: number }>();
		for (const f of reviewFiles) {
			if (f.additions > 0 || f.deletions > 0) {
				m.set(f.path, { additions: f.additions, deletions: f.deletions });
			}
		}
		return m;
	});

	// Map PR-changed files to @pierre/trees git-status entries. Files in the
	// repo tree that aren't in this map render with no decoration (they're
	// "unchanged" relative to the PR's base). The library accepts the four
	// statuses we care about plus 'ignored' / 'untracked' which don't apply
	// here.
	//
	// In `'changed'` scope every visible row is by definition a changed file,
	// so colouring them all would be redundant noise — the diff colours only
	// signal anything when there's something *unchanged* to contrast with.
	// Returning an empty map skips both the per-file `data-item-git-status`
	// attribute and the per-folder `data-item-contains-git-change` flag the
	// library derives from it, leaving the tree in its neutral colour.
	const statusByPath = $derived.by((): Map<string, GitStatusEntry['status']> => {
		const m = new Map<string, GitStatusEntry['status']>();
		if (fileTreeScope === 'changed') return m;
		for (const f of reviewFiles) {
			if (f.isNew) m.set(f.path, 'added');
			else if (f.isDeleted) m.set(f.path, 'deleted');
			else if (f.oldPath) m.set(f.path, 'renamed');
			else m.set(f.path, 'modified');
		}
		return m;
	});

	// Active files-mode search query. The store-level reset in
	// setSidebarView('prs') covers the swipe-back path; this effect handles
	// the other two cases where the path universe changes underneath the
	// query and stale matches would surface bogus results: switching PRs
	// (different head SHA → different file set) and toggling the file-tree
	// scope between 'all' / 'changed' (different visible-row population).
	$effect(() => {
		// Track both — explicit reads so Svelte's reactivity registers them.
		getSelectedPrId();
		getSettings()?.fileTreeScope;
		setFileSearchQuery('');
	});
	const searchQuery = $derived(getFileSearchQuery());

	function handleSelect(path: string): void {
		// Ignore directory selections — those are toggle-expansion-only.
		// (PierreFileTree also filters this in `onSelectionChange`, but
		// double-checking here keeps the contract local to this view.)
		if (!filePaths.has(path)) return;
		setActiveFilePath(path);
		requestDiffScrollReset();

		// Always swap the main pane to the Diff tab so the user sees
		// *something* (either the diff, or the file viewer for unchanged
		// files). Walkthrough/RequestChanges can be reached via the
		// FloatingTabs as before.
		if (getActiveTab() !== 'diff') setActiveTab('diff');
		enterScrollMode();

		const prId = getSelectedPrId();
		if (changedFileSet.has(path)) {
			// File is in the PR diff — DiffViewer renders the patch.
			// Clear any previously-loaded raw content so a stale viewer
			// doesn't flash through during a swap.
			clearRepoFile();
		} else if (prId) {
			// Unchanged file — fetch raw content from the local clone so
			// FileViewer can render it. Idempotent / cached per path.
			void loadRepoFile(prId, path);
		}
	}


</script>

<div class="files-view">
	<SidebarFilesSearch />

	{#if status === 'cloning'}
		<div class="placeholder">
			<span class="placeholder-text">Cloning repository…</span>
		</div>
	{:else if status === 'loading' && repoPaths.length === 0}
		<div class="placeholder">
			<span class="placeholder-text">
				{fileTreeScope === 'changed' ? 'Loading files…' : 'Loading repo tree…'}
			</span>
		</div>
	{:else if status === 'error'}
		<div class="placeholder placeholder--error">
			<span class="placeholder-text">{getRepoTreeError() ?? "Couldn't load the repo tree."}</span>
		</div>
	{:else if status === 'idle' && repoPaths.length === 0}
		<div class="placeholder">
			<span class="placeholder-text">No file tree yet.</span>
		</div>
	{:else}
		<PierreFileTree
			paths={repoPaths}
			{statusByPath}
			{statsMap}
			{activePath}
			{shouldFocus}
			{panelActive}
			{searchQuery}
			initialExpansion={fileTreeScope === 'changed' ? 'open' : 'closed'}
			onSelect={handleSelect}
		/>
	{/if}
</div>

<style>
	.files-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		width: 100%;
	}

	.placeholder {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}

	.placeholder-text {
		font-size: 11px;
		color: var(--color-text-muted);
		font-style: italic;
		text-align: center;
	}

	.placeholder--error .placeholder-text {
		color: var(--color-danger);
		font-style: normal;
	}
</style>
