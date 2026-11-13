<script lang="ts">
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import { ownedFileTitle, reviewOwnership } from "$lib/conversation/codeowners-review";
import { getConversation } from "$lib/stores/conversation.svelte";
import { getLoadedFiles, getReviewFiles } from "$lib/stores/diff-files.svelte";
import { enterScrollMode, getActivePanel } from "$lib/stores/focus-mode.svelte";
import {
  getActiveFilePath,
  getActiveTab,
  setActiveFilePath,
  setActiveTab,
} from "$lib/stores/pr-view-state.svelte";
import { scrollDiffToTop } from "$lib/stores/review-nav.svelte";
import { getSelectedPrId } from "$lib/stores/route.svelte";
import {
  getFileSearchQuery,
  getFilesNeedsMeOnly,
  getSidebarView,
  setFileSearchQuery,
  setFilesNeedsMeOnly,
} from "$lib/stores/sidebar.svelte";
import PierreFileTree from "./PierreFileTree.svelte";
import ReviewRequestHeader from "./ReviewRequestHeader.svelte";
import SidebarFilesSearch from "./SidebarFilesSearch.svelte";

const prId = $derived(getSelectedPrId());
const reviewFiles = $derived(prId ? getLoadedFiles(prId) : []);
const allPaths = $derived(reviewFiles.map((f) => f.path));

// CODEOWNERS ownership comes from the Conversation snapshot the review page
// loads on open; until it lands the tree shows without badges.
const conversation = $derived.by(() => {
  const request = prId ? getConversation(prId).request : null;
  return request?.status === "ok" ? request.data : null;
});
const ownership = $derived(conversation ? reviewOwnership(conversation, allPaths) : null);
const codeownersSource = $derived(
  conversation?.codeowners
    ? `${conversation.codeowners.path} on ${conversation.codeowners.ref}`
    : null,
);
const ownedTitles = $derived.by((): Map<string, string> => {
  const titles = new Map<string, string>();
  const path = conversation?.codeowners?.path;
  if (!ownership || !path) return titles;
  for (const [file, owned] of ownership.mine) titles.set(file, ownedFileTitle(owned, path));
  return titles;
});

// "Needs me" narrows the tree to the viewer's files; it can't empty the tree,
// so it only applies while there are some.
const needsMeOnly = $derived(getFilesNeedsMeOnly() && ownedTitles.size > 0);
const repoPaths = $derived(needsMeOnly ? allPaths.filter((p) => ownedTitles.has(p)) : allPaths);
const status = $derived(prId && getReviewFiles(prId).status === "loading" ? "loading" : "ready");
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
  setFilesNeedsMeOnly(false);
});
const searchQuery = $derived(getFileSearchQuery());

let search = $state<ReturnType<typeof SidebarFilesSearch>>();
let tree = $state<ReturnType<typeof PierreFileTree>>();

export function focusSearch(): void {
  search?.focus();
}

export function moveFocus(delta: 1 | -1): void {
  tree?.moveFocus(delta);
}

export function openFocused(): void {
  tree?.openFocused();
}

/** False when there is nowhere left to go up in the tree. */
export function collapseOrParent(): boolean {
  return tree?.collapseOrParent() ?? false;
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
	{#if ownership}
		<ReviewRequestHeader
			{ownership}
			source={codeownersSource}
			{needsMeOnly}
			onToggleNeedsMe={() => setFilesNeedsMeOnly(!needsMeOnly)}
		/>
	{/if}

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
			{ownedTitles}
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
