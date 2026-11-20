<script lang="ts">
import { loginsMatch } from "@revv/shared";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import {
  filesInScope,
  newerOf,
  resolveScope,
  reviewOwnership,
  scopedFileTitle,
} from "$lib/conversation/codeowners-review";
import {
  getOnlyScope,
  getOwnership,
  getPickedScope,
  isOwnershipSettled,
  repoLacksCodeowners,
  setOnlyScope,
  setPickedScope,
} from "$lib/conversation/ownership.svelte";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { getConversation, hasFreshConversation } from "$lib/stores/conversation.svelte";
import { getLoadedFiles, getReviewFiles } from "$lib/stores/diff-files.svelte";
import { enterScrollMode, getActivePanel } from "$lib/stores/focus-mode.svelte";
import {
  getActiveFilePath,
  getActiveTab,
  setActiveFilePath,
  setActiveTab,
} from "$lib/stores/pr-view-state.svelte";
import { getPrById } from "$lib/stores/prs.svelte";
import { scrollDiffToTop } from "$lib/stores/review-nav.svelte";
import { getSelectedPrId } from "$lib/stores/route.svelte";
import { getFileSearchQuery, getSidebarView, setFileSearchQuery } from "$lib/stores/sidebar.svelte";
import OwnerScopeFilter from "./OwnerScopeFilter.svelte";
import PierreFileTree from "./PierreFileTree.svelte";
import ReviewRequestLine from "./ReviewRequestLine.svelte";
import SidebarFilesSearch from "./SidebarFilesSearch.svelte";

/**
 * How long the tree waits for the ownership read before showing without it.
 * The read usually lands with the diff; waiting a moment makes the tree,
 * its badges and the request line appear in one go instead of shifting. It
 * only waits on a first visit where a line can come (see `ownershipReady`).
 */
const OWNERSHIP_WAIT_MS = 1000;

const prId = $derived(getSelectedPrId());
const reviewFiles = $derived(prId ? getLoadedFiles(prId) : []);
const allPaths = $derived(reviewFiles.map((f) => f.path));

// The light ownership read and the conversation carry the same fields; the
// fresher wins. The conversation's first paint can be an old cached snapshot,
// and after a write in the Conversation tab it is the newer of the two.
const source = $derived.by(() => {
  if (!prId) return null;
  const conversation = getConversation(prId).request;
  const read = getOwnership(prId);
  return newerOf(
    conversation.status === "ok" ? conversation.data : null,
    read.status === "ok" ? read.data : null,
  );
});
const ownership = $derived(source ? reviewOwnership(source, allPaths) : null);

const scope = $derived.by(
  (): ReadonlySet<string> =>
    ownership && prId ? resolveScope(ownership, getPickedScope(), prId) : new Set(),
);
const scoped = $derived(ownership ? filesInScope(ownership, scope) : new Map());
const scopedTitles = $derived.by((): Map<string, string> => {
  const titles = new Map<string, string>();
  const path = ownership?.source;
  if (!path) return titles;
  for (const [file, entry] of scoped) titles.set(file, scopedFileTitle(entry, path));
  return titles;
});
// "you" while the scope is the viewer's own; a teammate's group reads "owner".
const badgeLabel = $derived(
  ownership?.groups.every((g) => g.mine || !scope.has(g.owner)) ? "you" : "owner",
);

function toggleScope(owner: string): void {
  const next = new Set(scope);
  if (next.has(owner)) next.delete(owner);
  else next.add(owner);
  if (prId) setPickedScope({ owners: [...next], prId });
}

// "Only these files" narrows the tree to the scope; it can't empty the tree,
// so it only applies while the scope covers some.
const onlyScope = $derived(getOnlyScope() && scoped.size > 0);
const repoPaths = $derived(onlyScope ? allPaths.filter((p) => scoped.has(p)) : allPaths);

let waitedFor = $state<string | null>(null);
$effect(() => {
  const id = prId;
  if (!id) return;
  const timer = setTimeout(() => {
    waitedFor = id;
  }, OWNERSHIP_WAIT_MS);
  return () => clearTimeout(timer);
});
// Ready once GitHub's answer is in (the ownership read, or the full
// conversation, not its cached snapshot), or when waiting can't change
// what shows: the viewer wrote the PR, or the repo has no CODEOWNERS.
const ownershipReady = $derived.by(() => {
  if (!prId) return true;
  if (isOwnershipSettled(prId) || hasFreshConversation(prId) || waitedFor === prId) return true;
  const pr = getPrById(prId);
  if (!pr) return false;
  return loginsMatch(pr.authorLogin, getCurrentUserLogin()) || repoLacksCodeowners(pr.repositoryId);
});
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
	<SidebarFilesSearch bind:this={search} onSubmit={(query) => tree?.focusFirstMatch(query)}>
		{#snippet trailing()}
			{#if ownership && ownership.groups.length > 0}
				<OwnerScopeFilter
					groups={ownership.groups}
					{scope}
					scopedCount={scoped.size}
					{onlyScope}
					ontoggle={toggleScope}
					onOnlyScope={setOnlyScope}
					onreset={() => setPickedScope(null)}
					customized={getPickedScope() !== null}
				/>
			{/if}
		{/snippet}
	</SidebarFilesSearch>
	{#if ownership?.reason && ownershipReady}
		<ReviewRequestLine
			reason={ownership.reason}
			scopedCount={scoped.size}
			totalFiles={ownership.totalFiles}
		/>
	{/if}

	{#if (status === 'loading' && repoPaths.length === 0) || !ownershipReady}
		<div class="placeholder">
			<Dotmatrix variant="square-9" size="small" />
		</div>
	{:else}
		<PierreFileTree
			bind:this={tree}
			paths={repoPaths}
			statusByPath={new Map()}
			{statsMap}
			ownedTitles={scopedTitles}
			ownedBadge={badgeLabel}
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
