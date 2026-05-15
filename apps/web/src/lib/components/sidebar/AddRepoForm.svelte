<script lang="ts">
import { Loader2, Plus, RefreshCw, Search, Trash2 } from "@lucide/svelte";
import type { Repository } from "@revv/shared";
import { toast } from "svelte-sonner";
import CloneStatusIndicator from "$lib/components/shared/CloneStatusIndicator.svelte";
import {
  addRepo,
  deleteRepo,
  fetchAvailableRepos,
  getAvailableRepos,
  getAvailableReposLoading,
  getRepositories,
  retryClone,
} from "$lib/stores/prs.svelte";

// Shared "Add Repository" form. Renders the Browse/Manual tab content
// without a modal wrapper. Assumes the parent provides horizontal
// padding equivalent to `p-5` — the list and footer use small negative
// margins to extend visually past that padding, mirroring the original
// dialog look in both modal and inline contexts.
let {
  onClose,
  autoFocus = true,
  showTitle = true,
}: {
  onClose?: () => void;
  autoFocus?: boolean;
  showTitle?: boolean;
} = $props();

function focusOnMount(node: HTMLElement) {
  if (autoFocus) node.focus();
}

let activeTab = $state<"browse" | "manual">("browse");

// -- Browse tab state --
let browseSearch = $state("");
let addingRepos = $state(new Set<string>());
let removingRepos = $state(new Set<string>());
let highlightedIndex = $state(-1);
let repoListEl = $state<HTMLDivElement | null>(null);

// Map keyed by fullName so the trailing-icon block can read live clone
// state for repos that were already added. `getRepositories()` is reactive
// (server broadcasts `repos:clone-status` → store updates), so this Map
// re-derives whenever the clone status of any tracked repo changes.
let trackedByFullName = $derived(
  new Map<string, Repository>(getRepositories().map((r) => [r.fullName, r])),
);

let filteredAvailable = $derived(
  browseSearch.trim() === ""
    ? getAvailableRepos()
    : getAvailableRepos().filter(
        (repo) =>
          repo.fullName.toLowerCase().includes(browseSearch.toLowerCase()) ||
          repo.owner.toLowerCase().includes(browseSearch.toLowerCase()) ||
          repo.name.toLowerCase().includes(browseSearch.toLowerCase()),
      ),
);

let groupedByOwner = $derived.by(() => {
  const groups = new Map<string, typeof filteredAvailable>();
  for (const repo of filteredAvailable) {
    const existing = groups.get(repo.owner);
    if (existing) {
      existing.push(repo);
    } else {
      groups.set(repo.owner, [repo]);
    }
  }
  return groups;
});

$effect(() => {
  browseSearch;
  highlightedIndex = -1;
});

// -- Manual tab state --
let fullName = $state("");
let isLoading = $state(false);
let localError = $state("");

$effect(() => {
  if (getAvailableRepos().length === 0) {
    fetchAvailableRepos();
  }
});

async function handleBrowseAdd(repoFullName: string) {
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

async function handleBrowseRemove(repoId: string) {
  if (removingRepos.has(repoId)) return;
  removingRepos = new Set([...removingRepos, repoId]);
  try {
    await deleteRepo(repoId);
  } catch {
    // toast already shown by deleteRepo
  } finally {
    const next = new Set(removingRepos);
    next.delete(repoId);
    removingRepos = next;
  }
}

async function handleManualAdd() {
  const trimmed = fullName.trim();
  if (!trimmed?.includes("/")) {
    localError = "Enter a valid repo in owner/name format";
    return;
  }
  isLoading = true;
  localError = "";
  try {
    await addRepo(trimmed);
    fullName = "";
    onClose?.();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to add repository";
    localError = msg;
    toast.error(msg);
  } finally {
    isLoading = false;
  }
}

function scrollHighlightedIntoView() {
  if (!repoListEl) return;
  const el = repoListEl.querySelector<HTMLElement>('[data-highlighted="true"]');
  el?.scrollIntoView({ block: "nearest" });
}

function handleBrowseKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    onClose?.();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    highlightedIndex = Math.min(highlightedIndex + 1, filteredAvailable.length - 1);
    scrollHighlightedIntoView();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (highlightedIndex > 0) highlightedIndex--;
    scrollHighlightedIntoView();
  } else if (e.key === "Enter" && highlightedIndex >= 0) {
    const repo = filteredAvailable[highlightedIndex];
    if (repo) handleBrowseAdd(repo.fullName);
  } else if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault();
    activeTab = activeTab === "browse" ? "manual" : "browse";
  }
}

function handleManualKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") handleManualAdd();
  if (e.key === "Escape") onClose?.();
  if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault();
    activeTab = "browse";
  }
}
</script>

{#if showTitle}
	<h2 class="mb-3 flex-shrink-0 text-sm font-semibold text-text-primary">Add Repository</h2>
{/if}

<!-- Segmented control tabs -->
<div class="tab-switcher mb-3 flex-shrink-0">
	<div class="tab-track">
		<div class="tab-indicator" style="transform: translateX({activeTab === 'browse' ? '0%' : '100%'})"></div>
		<button
			class="tab-segment {activeTab === 'browse' ? 'tab-active' : ''}"
			onclick={() => (activeTab = 'browse')}
		>
			Browse
		</button>
		<button
			class="tab-segment {activeTab === 'manual' ? 'tab-active' : ''}"
			onclick={() => (activeTab = 'manual')}
		>
			Manual
		</button>
	</div>
</div>

<!-- Tab content -->
{#if activeTab === 'browse'}
	<div class="flex min-h-0 flex-1 flex-col">
		<!-- Search + refresh -->
		<div class="flex items-center gap-2 pb-2">
			<div class="search-input-wrap flex-1">
				<Search size={12} class="search-icon" />
				<input
					class="search-input"
					placeholder="Search repositories..."
					aria-label="Search repositories"
					bind:value={browseSearch}
					onkeydown={handleBrowseKeydown}
					use:focusOnMount
				/>
			</div>
			<button
				class="icon-btn"
				onclick={() => fetchAvailableRepos(true)}
				disabled={getAvailableReposLoading()}
				aria-label="Refresh repositories"
			>
				<RefreshCw size={13} class={getAvailableReposLoading() ? 'animate-spin' : ''} />
			</button>
		</div>

		<!-- Repo list -->
		<div class="-mx-3 flex-1 overflow-y-auto pb-1" bind:this={repoListEl}>
			{#if getAvailableReposLoading() && getAvailableRepos().length === 0}
				<div class="flex items-center justify-center py-12">
					<Loader2 size={18} class="animate-spin text-text-muted" />
					<span class="ml-2 text-xs text-text-muted">Loading repositories...</span>
				</div>
			{:else if getAvailableRepos().length === 0}
				<p class="py-12 text-center text-xs text-text-muted">
					No repositories found. Try refreshing.
				</p>
			{:else if filteredAvailable.length === 0}
				<p class="py-12 text-center text-xs text-text-muted">
					No repositories match "{browseSearch}"
				</p>
			{:else}
				{#each [...groupedByOwner] as [owner, repos] (owner)}
					<div class="mt-1">
						<!-- Owner header -->
						<div class="owner-header sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5">
							{#if repos[0]?.avatarUrl}
								<img
									src={repos[0].avatarUrl}
									alt=""
									class="h-4 w-4 rounded-full object-cover"
									loading="lazy"
									referrerpolicy="no-referrer"
									onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
								/>
							{/if}
							<span class="text-xs font-semibold uppercase tracking-wider text-text-muted"
								>{owner}</span
							>
						</div>

						<!-- Repos in this group -->
						{#each repos as repo (repo.fullName)}
							{@const trackedRepo = trackedByFullName.get(repo.fullName)}
							{@const isTracked = trackedRepo !== undefined}
							{@const isAdding = addingRepos.has(repo.fullName)}
							{@const isRemoving = trackedRepo ? removingRepos.has(trackedRepo.id) : false}
							{@const flatIndex = filteredAvailable.indexOf(repo)}
							{@const isHighlighted = flatIndex === highlightedIndex}
							<div
								role="button"
								tabindex={isTracked || isAdding ? -1 : 0}
								aria-disabled={isTracked || isAdding ? 'true' : undefined}
								class="repo-item flex w-full items-center gap-2 px-3 py-2 text-left
									{isHighlighted ? 'repo-item--highlighted' : ''}
									{!isTracked && !isAdding ? 'cursor-pointer' : ''}
									{isTracked ? 'repo-item--tracked' : ''}"
								data-highlighted={isHighlighted ? 'true' : undefined}
								onclick={() => {
									if (!isTracked && !isAdding) handleBrowseAdd(repo.fullName);
								}}
								onkeydown={(e) => {
									if ((e.key === 'Enter' || e.key === ' ') && !isTracked && !isAdding) {
										e.preventDefault();
										handleBrowseAdd(repo.fullName);
									}
								}}
							>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-1.5">
										<span
											class="truncate text-xs font-medium {isTracked
												? 'text-text-secondary'
												: 'text-text-primary'}">{repo.name}</span
										>
									</div>
								</div>
								<div class="flex flex-shrink-0 items-center gap-2">
									{#if isAdding}
										<Loader2 size={14} class="animate-spin text-text-muted" />
									{:else if isTracked && trackedRepo.cloneStatus !== 'ready'}
										<CloneStatusIndicator
											status={trackedRepo.cloneStatus}
											error={trackedRepo.cloneError}
											onRetry={() => retryClone(trackedRepo.id)}
											size={14}
											showLabel
										/>
									{/if}
									{#if isTracked}
										<button
											class="remove-btn"
											onclick={(e) => {
												e.stopPropagation();
												handleBrowseRemove(trackedRepo.id);
											}}
											disabled={isRemoving}
											aria-label="Remove {repo.fullName}"
										>
											{#if isRemoving}
												<Loader2 size={12} class="animate-spin" />
											{:else}
												<Trash2 size={12} />
											{/if}
										</button>
									{:else if !isAdding}
										<button
											class="add-badge"
											onclick={(e) => {
												e.stopPropagation();
												handleBrowseAdd(repo.fullName);
											}}
											aria-label="Add {repo.fullName}"
										>
											<Plus size={11} />
										</button>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/each}
			{/if}
		</div>
	</div>

	{#if onClose}
		<div class="-mx-5 mt-2 flex flex-shrink-0 justify-end border-t border-border px-5 pt-3">
			<button
				class="cursor-pointer rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text-secondary"
				onclick={onClose}
			>
				Done
			</button>
		</div>
	{/if}
{:else}
	<!-- Manual tab -->
	<div class="pt-4">
		<p class="mb-3 text-xs text-text-muted">Enter the repository in owner/name format</p>

		<input
			class="h-9 w-full rounded-lg border border-border bg-bg-elevated px-3 text-sm text-text-primary placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none"
			placeholder="owner/repository"
			aria-label="Repository name (owner/repository)"
			bind:value={fullName}
			onkeydown={handleManualKeydown}
			disabled={isLoading}
			use:focusOnMount
		/>

		{#if localError}
			<p class="mt-1.5 text-xs text-danger">{localError}</p>
		{/if}

		<div class="mt-4 flex justify-end gap-2">
			{#if onClose}
				<button
					class="cursor-pointer rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
					onclick={onClose}
					disabled={isLoading}
				>
					Cancel
				</button>
			{/if}
			<button
				class="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
				onclick={handleManualAdd}
				disabled={isLoading || !fullName.trim()}
			>
				{isLoading ? 'Adding...' : 'Add'}
			</button>
		</div>
	</div>
{/if}

<style>
	/* Segmented control tab switcher */
	.tab-switcher {
		padding: 2px;
	}

	.tab-track {
		position: relative;
		display: grid;
		grid-template-columns: 1fr 1fr;
		height: 28px;
		background: var(--color-glass-bg, rgba(255, 255, 255, 0.04));
		border: 1px solid var(--color-glass-border, rgba(255, 255, 255, 0.08));
		border-radius: 8px;
		padding: 2px;
		box-shadow: inset 0 0.5px 0 0 var(--color-glass-highlight, rgba(255, 255, 255, 0.06));
	}

	.tab-indicator {
		position: absolute;
		top: 2px;
		left: 2px;
		width: calc(50% - 2px);
		height: calc(100% - 4px);
		background: var(--color-glass-active-bg, rgba(255, 255, 255, 0.08));
		border: 1px solid var(--color-glass-border, rgba(255, 255, 255, 0.1));
		border-radius: 6px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 0.5px 0 0 var(--color-glass-highlight, rgba(255, 255, 255, 0.08));
		transition: transform var(--duration-quick) var(--ease-out-expo);
		pointer-events: none;
	}

	.tab-segment {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		border-radius: 5px;
		color: var(--color-text-muted);
		transition: color var(--duration-snap) var(--ease-soft);
		background: transparent;
		border: none;
		padding: 0 12px;
	}

	.tab-segment.tab-active {
		color: var(--color-text-primary);
	}

	/* Search input with icon */
	.search-input-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}

	.search-input-wrap :global(.search-icon) {
		position: absolute;
		left: 9px;
		color: var(--color-text-muted);
		pointer-events: none;
		flex-shrink: 0;
	}

	.search-input {
		height: 32px;
		width: 100%;
		padding-left: 28px;
		padding-right: 10px;
		font-size: 12px;
		background: var(--color-glass-bg, rgba(255, 255, 255, 0.04));
		border: 1px solid var(--color-glass-border, rgba(255, 255, 255, 0.08));
		border-radius: 7px;
		color: var(--color-text-primary);
		box-shadow: inset 0 0.5px 0 0 var(--color-glass-highlight, rgba(255, 255, 255, 0.04));
		transition: border-color var(--duration-instant) var(--ease-soft), box-shadow var(--duration-instant) var(--ease-soft);
		outline: none;
	}

	.search-input::placeholder {
		color: var(--color-text-muted);
	}

	.search-input:focus {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 1px var(--color-accent), inset 0 0.5px 0 0 var(--color-glass-highlight, rgba(255, 255, 255, 0.04));
	}

	/* Icon button (refresh) */
	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 32px;
		width: 32px;
		flex-shrink: 0;
		cursor: pointer;
		background: var(--color-glass-bg, rgba(255, 255, 255, 0.04));
		border: 1px solid var(--color-glass-border, rgba(255, 255, 255, 0.08));
		border-radius: 7px;
		color: var(--color-text-muted);
		box-shadow: inset 0 0.5px 0 0 var(--color-glass-highlight, rgba(255, 255, 255, 0.04));
		transition: border-color var(--duration-instant) var(--ease-soft), color var(--duration-instant) var(--ease-soft);
	}

	.icon-btn:hover:not(:disabled) {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.icon-btn:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* Owner section header */
	.owner-header {
		background: var(--color-glass-bg, rgba(255, 255, 255, 0.02));
		backdrop-filter: blur(8px);
	}

	/* Repo row */
	.repo-item {
		transition: background var(--duration-instant) var(--ease-soft);
		border-radius: 6px;
	}

	.repo-item:not(.repo-item--tracked):hover {
		background: var(--color-glass-active-bg, rgba(255, 255, 255, 0.06));
	}

	.repo-item--highlighted {
		background: var(--color-glass-active-bg, rgba(255, 255, 255, 0.06));
		box-shadow: inset 0 0 0 1px rgba(var(--color-accent-rgb, 99, 102, 241), 0.35);
	}

	/* Remove button */
	.remove-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 22px;
		width: 22px;
		cursor: pointer;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 5px;
		color: var(--color-text-muted);
		transition: color var(--duration-instant) var(--ease-soft), border-color var(--duration-instant) var(--ease-soft), background var(--duration-instant) var(--ease-soft);
	}

	.remove-btn:hover:not(:disabled) {
		color: var(--color-danger);
		border-color: rgba(var(--color-danger-rgb, 239, 68, 68), 0.3);
		background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.08);
	}

	.remove-btn:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* Add badge (Plus icon) */
	.add-badge {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 20px;
		width: 20px;
		cursor: pointer;
		background: rgba(var(--color-accent-rgb, 99, 102, 241), 0.1);
		border: 1px solid rgba(var(--color-accent-rgb, 99, 102, 241), 0.25);
		border-radius: 5px;
		color: var(--color-accent);
		transition: background var(--duration-instant) var(--ease-soft), border-color var(--duration-instant) var(--ease-soft);
	}

	.add-badge:hover {
		background: rgba(var(--color-accent-rgb, 99, 102, 241), 0.2);
		border-color: rgba(var(--color-accent-rgb, 99, 102, 241), 0.4);
	}
</style>
