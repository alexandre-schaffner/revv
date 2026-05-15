<script lang="ts">
	import {
		getSidebarView,
		getFileSearchQuery,
		setFileSearchQuery,
	} from '$lib/stores/sidebar.svelte';
	import {
		getReviewFiles,
		getActiveFilePath,
		setActiveFilePath,
		getActiveTab,
		setActiveTab,
		getIsLoadingFiles,
		clearRepoFile,
		requestDiffScrollReset,
	} from '$lib/stores/review.svelte';
	import { getSelectedPrId } from '$lib/stores/prs.svelte';
	import { enterScrollMode, getActivePanel } from '$lib/stores/focus-mode.svelte';
	import PierreFileTree from './PierreFileTree.svelte';
	import SidebarFilesSearch from './SidebarFilesSearch.svelte';

	const reviewFiles = $derived(getReviewFiles());
	const repoPaths = $derived(reviewFiles.map((f) => f.path));
	const status = $derived(getIsLoadingFiles() ? 'loading' : 'ready');
	const activePath = $derived(getActiveFilePath());
	const shouldFocus = $derived(getSidebarView() === 'files');
	const panelActive = $derived(getActivePanel() === 'sidebar');
	const filePaths = $derived(new Set(repoPaths));

	const statsMap = $derived.by((): Map<string, { additions: number; deletions: number }> => {
		const m = new Map<string, { additions: number; deletions: number }>();
		for (const f of reviewFiles) {
			if (f.additions > 0 || f.deletions > 0) {
				m.set(f.path, { additions: f.additions, deletions: f.deletions });
			}
		}
		return m;
	});

	$effect(() => {
		getSelectedPrId();
		setFileSearchQuery('');
	});
	const searchQuery = $derived(getFileSearchQuery());

	function handleSelect(path: string): void {
		if (!filePaths.has(path)) return;
		setActiveFilePath(path);
		requestDiffScrollReset();
		if (getActiveTab() !== 'diff') setActiveTab('diff');
		enterScrollMode();
		clearRepoFile();
	}
</script>

<div class="files-view">
	<SidebarFilesSearch />

	{#if status === 'loading' && repoPaths.length === 0}
		<div class="placeholder">
			<span class="placeholder-text">Loading files…</span>
		</div>
	{:else}
		<PierreFileTree
			paths={repoPaths}
			statusByPath={new Map()}
			{statsMap}
			{activePath}
			{shouldFocus}
			{panelActive}
			{searchQuery}
			initialExpansion="open"
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

</style>
