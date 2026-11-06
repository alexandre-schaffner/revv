<script lang="ts">
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import { enterScrollMode, getActivePanel } from "$lib/stores/focus-mode.svelte";
import { getSelectedPrId } from "$lib/stores/prs.svelte";
import {
  getActiveFilePath,
  getActiveTab,
  getIsLoadingFiles,
  getReviewFiles,
  setActiveFilePath,
  setActiveTab,
} from "$lib/stores/review.svelte";
import { scrollDiffToTop } from "$lib/stores/review-nav.svelte";
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

let search = $state<ReturnType<typeof SidebarFilesSearch>>();
let tree = $state<ReturnType<typeof PierreFileTree>>();

export function focusSearch(): void {
  search?.focus();
}

/**
 * The sidebar's vim keys while the file tree is showing. `exit` means "h" had
 * nowhere left to go in the tree: back out to the PR list.
 */
export function navigate(key: string): "handled" | "exit" | "ignored" {
  switch (key) {
    case "j":
      tree?.moveFocus(1);
      return "handled";
    case "k":
      tree?.moveFocus(-1);
      return "handled";
    case "l":
      tree?.openFocused();
      return "handled";
    case "h":
      return tree?.collapseOrParent() ? "handled" : "exit";
    default:
      return "ignored";
  }
}

function handleSelect(path: string): void {
  if (!filePaths.has(path)) return;
  setActiveFilePath(path);
  scrollDiffToTop();
  if (getActiveTab() !== "diff") setActiveTab("diff");
  enterScrollMode();
}
</script>

<div class="files-view">
	<SidebarFilesSearch bind:this={search} onSubmit={(query) => tree?.focusFirstMatch(query)} />

	{#if status === 'loading' && repoPaths.length === 0}
		<div class="placeholder">
			<Dotmatrix variant="square-9" size="small" />
		</div>
	{:else}
		<PierreFileTree
			bind:this={tree}
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
