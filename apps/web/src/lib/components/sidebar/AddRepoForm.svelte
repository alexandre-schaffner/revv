<script lang="ts">
import { Folder, Plus, RefreshCw, Search, Trash2 } from "@lucide/svelte";
import type { Repository } from "@revv/shared";
import { toast } from "svelte-sonner";
import CloneStatusIndicator from "$lib/components/shared/CloneStatusIndicator.svelte";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import {
  addRepo,
  deleteRepo,
  fetchAvailableRepos,
  getAvailablePrCount,
  getAvailablePrCountsLoaded,
  getAvailableRepos,
  getAvailableReposLoading,
  getPullRequests,
  getRepositories,
  retryClone,
} from "$lib/stores/prs.svelte";

// Shared "Add Repository" form. Renders without a modal wrapper so it can
// be embedded inline. The parent provides horizontal padding equivalent
// to `p-5`; the list extends visually past it with small negative margins.
let {
  onClose,
  autoFocus = true,
  showTitle = true,
}: {
  onClose?: () => void;
  autoFocus?: boolean;
  showTitle?: boolean;
} = $props();

const MANUAL_REPO_REGEX = /^[\w.-]+\/[\w.-]+$/;

function focusOnMount(node: HTMLElement) {
  if (autoFocus) requestAnimationFrame(() => node.focus());
}

let search = $state("");
let addingRepos = $state(new Set<string>());
let removingRepos = $state(new Set<string>());
let highlightedIndex = $state(-1);
let repoListEl = $state<HTMLDivElement | null>(null);
let isManualLoading = $state(false);

// Reactive map of tracked repos so clone-status changes ripple through.
let trackedByFullName = $derived(
  new Map<string, Repository>(getRepositories().map((r) => [r.fullName, r])),
);

// Open-PR count per tracked repo, surfaced as the dropdown hint.
let openPrCountByRepoId = $derived.by(() => {
  const m = new Map<string, number>();
  for (const pr of getPullRequests()) {
    m.set(pr.repositoryId, (m.get(pr.repositoryId) ?? 0) + 1);
  }
  return m;
});

let trimmedSearch = $derived(search.trim());

let filteredAvailable = $derived(
  trimmedSearch === ""
    ? getAvailableRepos()
    : getAvailableRepos().filter((repo) => {
        const q = trimmedSearch.toLowerCase();
        return (
          repo.fullName.toLowerCase().includes(q) ||
          repo.owner.toLowerCase().includes(q) ||
          repo.name.toLowerCase().includes(q)
        );
      }),
);

let groupedByOwner = $derived.by(() => {
  const groups = new Map<string, typeof filteredAvailable>();
  for (const repo of filteredAvailable) {
    const existing = groups.get(repo.owner);
    if (existing) existing.push(repo);
    else groups.set(repo.owner, [repo]);
  }
  return groups;
});

// The manual-import row appears when the query parses as owner/name AND
// there is no exact match in the browsable list. This unifies the old
// Manual tab into the single search input.
let showManualImport = $derived.by(() => {
  if (!MANUAL_REPO_REGEX.test(trimmedSearch)) return false;
  const lowered = trimmedSearch.toLowerCase();
  return !filteredAvailable.some((r) => r.fullName.toLowerCase() === lowered);
});

// Combined selectable list for keyboard nav: manual-import row first
// (when shown), then available repos.
let selectableCount = $derived(filteredAvailable.length + (showManualImport ? 1 : 0));

let isManualAlreadyTracked = $derived(showManualImport && trackedByFullName.has(trimmedSearch));

// When the query changes, default focus on the manual-import row if it's
// shown — that's the "primary" action when the user types an explicit slug.
$effect(() => {
  search;
  highlightedIndex = showManualImport ? 0 : -1;
});

$effect(() => {
  if (getAvailableRepos().length === 0) fetchAvailableRepos();
});

async function handleAdd(repoFullName: string) {
  if (addingRepos.has(repoFullName) || trackedByFullName.has(repoFullName)) return;
  addingRepos = new Set([...addingRepos, repoFullName]);
  try {
    await addRepo(repoFullName);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to add repository");
  } finally {
    const next = new Set(addingRepos);
    next.delete(repoFullName);
    addingRepos = next;
  }
}

async function handleRemove(repoId: string) {
  if (removingRepos.has(repoId)) return;
  removingRepos = new Set([...removingRepos, repoId]);
  try {
    await deleteRepo(repoId);
  } catch {
    // toast handled by store
  } finally {
    const next = new Set(removingRepos);
    next.delete(repoId);
    removingRepos = next;
  }
}

async function handleManualImport() {
  const slug = trimmedSearch;
  if (!MANUAL_REPO_REGEX.test(slug)) {
    toast.error("Enter a valid repository in owner/name format");
    return;
  }
  if (trackedByFullName.has(slug)) {
    toast.error("Repository is already tracked");
    return;
  }
  isManualLoading = true;
  try {
    await addRepo(slug);
    search = "";
    onClose?.();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to add repository");
  } finally {
    isManualLoading = false;
  }
}

function scrollHighlightedIntoView() {
  if (!repoListEl) return;
  const el = repoListEl.querySelector<HTMLElement>('[data-highlighted="true"]');
  el?.scrollIntoView({ block: "nearest" });
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    onClose?.();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    highlightedIndex = Math.min(highlightedIndex + 1, selectableCount - 1);
    scrollHighlightedIntoView();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (highlightedIndex > 0) highlightedIndex--;
    scrollHighlightedIntoView();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (showManualImport && highlightedIndex === 0) {
      void handleManualImport();
      return;
    }
    const idx = showManualImport ? highlightedIndex - 1 : highlightedIndex;
    const repo = filteredAvailable[idx];
    if (repo) {
      void handleAdd(repo.fullName);
    } else if (MANUAL_REPO_REGEX.test(trimmedSearch)) {
      void handleManualImport();
    }
  }
}

let trackedCount = $derived(getRepositories().length);
</script>

{#if showTitle}
	<div class="form-header">
		<h2 class="title">Add Repository</h2>
		{#if trackedCount > 0}
			<span class="title-meta">{trackedCount} tracked</span>
		{/if}
	</div>
{/if}

<!-- Search + refresh -->
<div class="search-row">
	<div class="search-input-wrap">
		<Search size={13} class="search-icon" />
		<input
			class="search-input"
			placeholder="Search or type owner/name…"
			aria-label="Search repositories or paste owner/repository"
			bind:value={search}
			onkeydown={handleKeydown}
			use:focusOnMount
			autocomplete="off"
			autocorrect="off"
			autocapitalize="off"
			spellcheck="false"
		/>
		{#if search}
			<button
				type="button"
				class="clear-btn"
				onclick={() => (search = '')}
				aria-label="Clear search"
				tabindex="-1"
			>
				<span aria-hidden="true">×</span>
			</button>
		{/if}
	</div>
	<button
		class="refresh-btn"
		onclick={() => fetchAvailableRepos(true)}
		disabled={getAvailableReposLoading()}
		aria-label="Refresh repositories"
		title="Refresh repositories"
	>
		<RefreshCw size={13} class={getAvailableReposLoading() ? 'animate-spin' : ''} />
	</button>
</div>

<!-- List -->
<div class="repo-list" bind:this={repoListEl}>
	{#if showManualImport}
		{@const isImportHighlighted = highlightedIndex === 0}
		<button
			type="button"
			class="dropdown-row dropdown-row--import"
			class:dropdown-row--highlighted={isImportHighlighted}
			class:dropdown-row--disabled={isManualAlreadyTracked || isManualLoading}
			data-highlighted={isImportHighlighted ? 'true' : undefined}
			disabled={isManualAlreadyTracked || isManualLoading}
			onclick={() => void handleManualImport()}
			onmouseenter={() => (highlightedIndex = 0)}
		>
			<span class="dropdown-icon" aria-hidden="true">
				{#if isManualLoading}
					<Dotmatrix variant="square-10" size="small" />
				{:else}
					<Plus size={12} />
				{/if}
			</span>
			<div class="dropdown-body">
				<span class="dropdown-title">{trimmedSearch}</span>
				<span class="dropdown-hint">
					{#if isManualAlreadyTracked}
						Already tracked
					{:else if isManualLoading}
						Importing…
					{:else}
						Import this repository
					{/if}
				</span>
			</div>
		</button>
	{/if}

	{#if getAvailableReposLoading() && getAvailableRepos().length === 0}
		<div class="state-block">
			<Dotmatrix variant="square-10" />
			<span>Loading repositories...</span>
		</div>
	{:else if getAvailableRepos().length === 0}
		<div class="state-block">
			<span>No repositories found. Try refreshing.</span>
		</div>
	{:else if filteredAvailable.length === 0 && !showManualImport}
		<div class="state-block state-block--hint">
			<span>No repositories match <em>"{trimmedSearch}"</em>.</span>
			<span class="state-hint">Tip: paste <span class="kbd-inline">owner/name</span> to import any repo.</span>
		</div>
	{:else if filteredAvailable.length > 0}
		{#each [...groupedByOwner] as [owner, repos] (owner)}
			<div class="owner-group">
				<div class="owner-header">
					{#if repos[0]?.avatarUrl}
						<img
							src={repos[0].avatarUrl}
							alt=""
							class="owner-avatar"
							loading="lazy"
							referrerpolicy="no-referrer"
							onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
						/>
					{/if}
					<span class="owner-name">{owner}</span>
					<span class="owner-count">{repos.length}</span>
				</div>

				{#each repos as repo (repo.fullName)}
					{@const trackedRepo = trackedByFullName.get(repo.fullName)}
					{@const isTracked = trackedRepo !== undefined}
					{@const isAdding = addingRepos.has(repo.fullName)}
					{@const isRemoving = trackedRepo ? removingRepos.has(trackedRepo.id) : false}
					{@const flatIndex = filteredAvailable.indexOf(repo)}
					{@const navIndex = showManualImport ? flatIndex + 1 : flatIndex}
					{@const isHighlighted = navIndex === highlightedIndex}
					{@const prCount = trackedRepo
						? (openPrCountByRepoId.get(trackedRepo.id) ?? 0)
						: (getAvailablePrCount(repo.fullName) ?? (getAvailablePrCountsLoaded() ? 0 : undefined))}
					<div
						role="button"
						tabindex={isTracked || isAdding ? -1 : 0}
						aria-disabled={isTracked || isAdding ? 'true' : undefined}
						class="dropdown-row"
						class:dropdown-row--highlighted={isHighlighted}
						class:dropdown-row--tracked={isTracked}
						class:dropdown-row--actionable={!isTracked && !isAdding}
						data-highlighted={isHighlighted ? 'true' : undefined}
						onmouseenter={() => (highlightedIndex = navIndex)}
						onclick={() => {
							if (!isTracked && !isAdding) handleAdd(repo.fullName);
						}}
						onkeydown={(e) => {
							if ((e.key === 'Enter' || e.key === ' ') && !isTracked && !isAdding) {
								e.preventDefault();
								handleAdd(repo.fullName);
							}
						}}
					>
						{#if repo.avatarUrl}
							<img
								class="dropdown-avatar"
								src={repo.avatarUrl}
								alt=""
								loading="lazy"
								referrerpolicy="no-referrer"
								onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
							/>
						{:else}
							<span class="dropdown-icon dropdown-icon--repo" aria-hidden="true">
								<Folder size={12} />
							</span>
						{/if}

						<div class="dropdown-body">
							<span class="dropdown-title">{repo.name}</span>
							{#if prCount !== undefined}
								<span class="dropdown-hint">{prCount === 0 ? 'No open PRs' : `${prCount} open PR${prCount === 1 ? '' : 's'}`}</span>
							{/if}
						</div>

						<div class="repo-actions">
							{#if isAdding}
								<Dotmatrix variant="square-10" size="small" />
							{:else if isTracked && trackedRepo.cloneStatus !== 'ready'}
								<CloneStatusIndicator
									status={trackedRepo.cloneStatus}
									error={trackedRepo.cloneError}
									onRetry={() => retryClone(trackedRepo.id)}
									size={13}
									showLabel
								/>
							{:else if isTracked}
								<span class="tracked-pill">Tracked</span>
							{/if}

							{#if isTracked}
								<button
									type="button"
									class="remove-btn"
									onclick={(e) => {
										e.stopPropagation();
										handleRemove(trackedRepo.id);
									}}
									disabled={isRemoving}
									aria-label="Remove {repo.fullName}"
									title="Remove {repo.fullName}"
								>
									{#if isRemoving}
										<Dotmatrix variant="square-10" size="small" />
									{:else}
										<Trash2 size={11} />
									{/if}
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/each}
	{/if}
</div>

{#if onClose}
	<div class="footer">
		<button class="done-btn" onclick={onClose}>Done</button>
	</div>
{/if}

<style>
	/* ── Header ─────────────────────────────────────────── */
	.form-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 12px;
		flex-shrink: 0;
	}

	.title {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--color-text-primary);
		letter-spacing: -0.005em;
		margin: 0;
	}

	.title-meta {
		font-size: 11px;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* ── Search row ─────────────────────────────────────── */
	.search-row {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
	}

	.search-input-wrap {
		position: relative;
		display: flex;
		align-items: center;
		flex: 1;
	}

	.search-input-wrap :global(.search-icon) {
		position: absolute;
		left: 11px;
		color: var(--color-text-muted);
		pointer-events: none;
		flex-shrink: 0;
		transition: color var(--duration-snap) var(--ease-soft);
	}

	.search-input-wrap:focus-within :global(.search-icon) {
		color: var(--color-text-secondary);
	}

	.search-input {
		height: 32px;
		width: 100%;
		padding: 0 30px 0 30px;
		font-size: 12.5px;
		font-weight: 450;
		background: var(--color-glass-bg, rgba(255, 255, 255, 0.03));
		border: 1px solid var(--color-glass-border, rgba(255, 255, 255, 0.07));
		border-radius: 9999px;
		color: var(--color-text-primary);
		transition:
			border-color var(--duration-instant) var(--ease-soft),
			background var(--duration-instant) var(--ease-soft);
		outline: none;
	}

	.search-input::placeholder {
		color: var(--color-text-muted);
	}

	.search-input:focus {
		border-color: color-mix(in srgb, var(--color-text-primary) 22%, transparent);
		background: var(--color-glass-active-bg, rgba(255, 255, 255, 0.05));
	}

	.clear-btn {
		position: absolute;
		right: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		font-size: 14px;
		line-height: 1;
		color: var(--color-text-muted);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		transition: color var(--duration-instant) var(--ease-soft), background var(--duration-instant) var(--ease-soft);
	}

	.clear-btn:hover {
		color: var(--color-text-primary);
		background: var(--color-glass-active-bg, rgba(255, 255, 255, 0.08));
	}

	.refresh-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 32px;
		width: 32px;
		flex-shrink: 0;
		cursor: pointer;
		background: transparent;
		border: 1px solid var(--color-glass-border, rgba(255, 255, 255, 0.07));
		border-radius: 7px;
		color: var(--color-text-muted);
		transition:
			color var(--duration-instant) var(--ease-soft),
			background var(--duration-instant) var(--ease-soft);
	}

	.refresh-btn:hover:not(:disabled) {
		color: var(--color-text-primary);
		background: var(--color-glass-active-bg, rgba(255, 255, 255, 0.04));
	}

	.refresh-btn:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* ── List ───────────────────────────────────────────── */
	.repo-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		margin: 0 -12px;
		padding: 0 8px 4px;
		scroll-padding-top: 36px;
	}

	.repo-list::-webkit-scrollbar {
		width: 8px;
	}
	.repo-list::-webkit-scrollbar-track {
		background: transparent;
	}
	.repo-list::-webkit-scrollbar-thumb {
		background: var(--color-glass-border, rgba(255, 255, 255, 0.08));
		border-radius: 4px;
		border: 2px solid transparent;
		background-clip: padding-box;
	}
	.repo-list::-webkit-scrollbar-thumb:hover {
		background: var(--color-glass-active-bg, rgba(255, 255, 255, 0.14));
		background-clip: padding-box;
	}

	/* ── Dropdown-style row (manual-import + repo) ──────── */
	.dropdown-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 8px 10px;
		border-radius: 8px;
		background: transparent;
		border: none;
		text-align: left;
		cursor: pointer;
		outline: none;
		color: var(--color-text-primary);
		transition: background-color var(--duration-snap) var(--ease-soft);
	}

	.dropdown-row:hover:not(:disabled),
	.dropdown-row--highlighted:not(:disabled) {
		background: var(--color-bg-tertiary);
	}

	.dropdown-row--disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.dropdown-row--tracked:not(:hover):not(.dropdown-row--highlighted) {
		cursor: default;
	}

	.dropdown-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		margin-top: 2px;
		color: var(--color-accent);
	}

	.dropdown-avatar {
		flex-shrink: 0;
		width: 14px;
		height: 14px;
		margin-top: 2px;
		border-radius: 999px;
		object-fit: cover;
	}

	.dropdown-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.dropdown-title {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dropdown-row--import .dropdown-title {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
	}

	.dropdown-row--tracked .dropdown-title {
		color: var(--color-text-secondary);
	}

	.dropdown-hint {
		font-size: 11px;
		color: var(--color-text-muted);
		line-height: 1.4;
	}

	/* ── Owner groups ───────────────────────────────────── */
	.owner-group + .owner-group {
		margin-top: 6px;
	}

	.owner-header {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 12px 10px 6px;
		background: var(--color-bg-secondary);
	}

	.owner-avatar {
		width: 13px;
		height: 13px;
		border-radius: 999px;
		object-fit: cover;
		flex-shrink: 0;
		opacity: 0.8;
	}

	.owner-name {
		font-size: 11px;
		font-weight: 500;
		color: var(--color-text-secondary);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.owner-count {
		font-size: 10.5px;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* ── Right-side actions (status / tracked / remove) ───── */
	.repo-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.tracked-pill {
		font-size: 10.5px;
		color: var(--color-text-muted);
	}

	.remove-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 22px;
		width: 22px;
		cursor: pointer;
		background: transparent;
		border: none;
		border-radius: 5px;
		color: var(--color-text-muted);
		opacity: 0.6;
		transition:
			color var(--duration-instant) var(--ease-soft),
			background var(--duration-instant) var(--ease-soft),
			opacity var(--duration-instant) var(--ease-soft);
	}

	.dropdown-row:hover .remove-btn {
		opacity: 1;
	}

	.remove-btn:hover:not(:disabled) {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		opacity: 1;
	}

	.remove-btn:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* ── State blocks (empty / loading) ─────────────────── */
	.state-block {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 36px 16px;
		font-size: 12px;
		color: var(--color-text-muted);
		text-align: center;
	}

	.state-block--hint em {
		color: var(--color-text-secondary);
		font-style: italic;
	}

	.state-hint {
		font-size: 11px;
		opacity: 0.8;
	}

	/* ── Footer ─────────────────────────────────────────── */
	.footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		margin: 8px -20px 0;
		padding: 10px 20px 0;
		border-top: 1px solid var(--color-border-subtle, var(--color-glass-border, rgba(255, 255, 255, 0.06)));
		flex-shrink: 0;
	}

	.done-btn {
		cursor: pointer;
		padding: 5px 14px;
		font-size: 11.5px;
		font-weight: 500;
		color: var(--color-text-muted);
		background: transparent;
		border: none;
		border-radius: 6px;
		transition: color var(--duration-instant) var(--ease-soft);
	}

	.done-btn:hover {
		color: var(--color-text-primary);
	}
</style>
