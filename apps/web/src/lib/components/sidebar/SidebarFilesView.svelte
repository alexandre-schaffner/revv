<script lang="ts">
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import { enterScrollMode, getActivePanel } from "$lib/stores/focus-mode.svelte";
import { getSelectedPrId } from "$lib/stores/prs.svelte";
import {
  clearRepoFile,
  getActiveFilePath,
  getActiveTab,
  getIsLoadingFiles,
  getReviewFiles,
  requestDiffScrollReset,
  setActiveFilePath,
  setActiveTab,
} from "$lib/stores/review.svelte";
import { getFileSearchQuery, getSidebarView, setFileSearchQuery } from "$lib/stores/sidebar.svelte";
import PierreFileTree from "./PierreFileTree.svelte";
import SidebarFilesSearch from "./SidebarFilesSearch.svelte";

const reviewFiles = $derived(getReviewFiles());
const repoPaths = $derived(reviewFiles.map((f) => f.path));
const status = $derived(getIsLoadingFiles() ? "loading" : "ready");
const activePath = $derived(getActiveFilePath());
const shouldFocus = $derived(getSidebarView() === "files");
const panelActive = $derived(getActivePanel() === "sidebar");
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
  setFileSearchQuery("");
});
const searchQuery = $derived(getFileSearchQuery());

function handleSelect(path: string): void {
  if (!filePaths.has(path)) return;
  setActiveFilePath(path);
  requestDiffScrollReset();
  if (getActiveTab() !== "diff") setActiveTab("diff");
  enterScrollMode();
  clearRepoFile();
}
</script>

<div class="files-view">
	<SidebarFilesSearch />

	{#if status === 'loading' && repoPaths.length === 0}
		<div class="placeholder">
			<Dotmatrix variant="square-9" size="small" />
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
		gap: 8px;
		padding: 16px;
	}

</style>
