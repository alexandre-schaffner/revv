<script lang="ts">
import type { Repository } from "@revv/shared";
import ArrowRight from "phosphor-svelte/lib/ArrowRight";
import RefreshCw from "phosphor-svelte/lib/ArrowsClockwise";
import Folder from "phosphor-svelte/lib/Folder";
import GitPullRequest from "phosphor-svelte/lib/GitPullRequest";
import LinkSimple from "phosphor-svelte/lib/LinkSimple";
import Plus from "phosphor-svelte/lib/Plus";
import Spinner from "phosphor-svelte/lib/Spinner";
import Trash2 from "phosphor-svelte/lib/Trash";
import { toast } from "svelte-sonner";
import CloneStatusIndicator from "$lib/components/shared/CloneStatusIndicator.svelte";
import OwnerAvatar from "$lib/components/shared/OwnerAvatar.svelte";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Command from "$lib/components/ui/command/index.js";
import {
  addRepo,
  deleteRepo,
  fetchAvailableRepos,
  getAvailablePrCount,
  getAvailablePrCountsLoaded,
  getAvailableRepos,
  getAvailableReposFetchFailed,
  getAvailableReposLoading,
  getDefaultCloneBaseDir,
  getPullRequests,
  getRepositories,
  retryClone,
} from "$lib/stores/prs.svelte";
import { isTauri } from "$lib/utils/platform";
import RepoDeleteConfirm from "./RepoDeleteConfirm.svelte";
import RepoDialogHeader from "./RepoDialogHeader.svelte";
import RepoField from "./RepoField.svelte";

// Shared "Add Repository" picker. Built on the shadcn `Command` (cmdk)
// primitive so the search input is pinned, the list is the only scroll
// region, and keyboard nav / selection come for free. Renders without a
// modal wrapper so it can be embedded inline; the parent supplies padding.
let {
  onClose,
  autoFocus = true,
  showTitle = true,
  showLocation = false,
  cloneBasePath = "",
  onCloneBasePathChange,
  onCloneSuccess,
}: {
  onClose?: () => void;
  autoFocus?: boolean;
  showTitle?: boolean;
  showLocation?: boolean;
  cloneBasePath?: string;
  onCloneBasePathChange?: (path: string) => void;
  onCloneSuccess?: (basePath: string) => void;
} = $props();

const MANUAL_REPO_REGEX = /^[\w.-]+\/[\w.-]+$/;
const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 2000;
const MANUAL_IMPORT_VALUE = "__manual_import__";

let search = $state("");
let addingRepos = $state(new Set<string>());
let removingRepos = $state(new Set<string>());
let isManualLoading = $state(false);
let browsing = $state(false);
let repoPendingDelete = $state<Repository | null>(null);
let autoRetries = $state(0);
let searchEl = $state<HTMLInputElement | null>(null);
const runningInTauri = isTauri();

// Focus the search on mount (rAF so it lands after the dialog's open motion),
// avoiding the `autofocus` attribute and its a11y lint.
$effect(() => {
  if (autoFocus && searchEl) requestAnimationFrame(() => searchEl?.focus());
});

// Reactive map of tracked repos so clone-status changes ripple through.
let trackedByFullName = $derived(
  new Map<string, Repository>(getRepositories().map((r) => [r.fullName, r])),
);

// Open-PR count per tracked repo, surfaced as a row badge.
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

let isManualAlreadyTracked = $derived(showManualImport && trackedByFullName.has(trimmedSearch));

// One source of truth for which list state to render.
let listState = $derived.by<"loading" | "error" | "empty" | "no-match" | "groups">(() => {
  const hasRepos = getAvailableRepos().length > 0;
  if (hasRepos) return filteredAvailable.length > 0 ? "groups" : "no-match";
  if (getAvailableReposLoading()) return "loading";
  if (getAvailableReposFetchFailed()) {
    return autoRetries < MAX_AUTO_RETRIES ? "loading" : "error";
  }
  return "empty";
});

$effect(() => {
  if (
    getAvailableRepos().length === 0 &&
    !getAvailableReposLoading() &&
    !getAvailableReposFetchFailed()
  ) {
    fetchAvailableRepos();
  }
});

// Auto-retry: a freshly-issued GitHub token can briefly 401 during the race
// between sign-in and propagation. Retry a few times before falling back to
// the manual Retry button.
$effect(() => {
  if (!getAvailableReposFetchFailed() || autoRetries >= MAX_AUTO_RETRIES) return;
  const timer = setTimeout(() => {
    autoRetries++;
    fetchAvailableRepos(true);
  }, AUTO_RETRY_DELAY_MS);
  return () => clearTimeout(timer);
});

function retryFetch(): void {
  autoRetries = 0;
  fetchAvailableRepos(true);
}

async function handleAdd(repoFullName: string) {
  if (addingRepos.has(repoFullName) || trackedByFullName.has(repoFullName)) return;
  addingRepos = new Set([...addingRepos, repoFullName]);
  try {
    await addRepo(addBody(repoFullName));
    rememberCloneBase();
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
    repoPendingDelete = null;
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
    await addRepo(addBody(slug));
    rememberCloneBase();
    search = "";
    onClose?.();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to add repository");
  } finally {
    isManualLoading = false;
  }
}

let trackedCount = $derived(getRepositories().length);
let trimmedCloneBasePath = $derived(cloneBasePath.trim());
// Empty field falls back to the server's default base; both the preview and
// the submitted `basePath` read through this single value, never a literal.
let effectiveBase = $derived(trimmedCloneBasePath || getDefaultCloneBaseDir() || "");
let resolvedClonePath = $derived.by(() => {
  if (!showLocation || !effectiveBase || !MANUAL_REPO_REGEX.test(trimmedSearch)) return null;
  const [owner, name] = trimmedSearch.split("/");
  if (!owner || !name) return null;
  return `${effectiveBase.replace(/\/$/, "")}/${owner}/${name}`;
});

function addBody(repoFullName: string) {
  if (!showLocation) return repoFullName;
  // Only send a custom base; an empty field defers to the server's default
  // (omitting `basePath`) rather than echoing a guessed path.
  if (!trimmedCloneBasePath) return { fullName: repoFullName, mode: "clone" as const };
  return { fullName: repoFullName, mode: "clone" as const, basePath: trimmedCloneBasePath };
}

function rememberCloneBase(): void {
  if (!showLocation) return;
  onCloneSuccess?.(trimmedCloneBasePath);
}

async function browseForCloneBase(): Promise<void> {
  if (!runningInTauri || browsing) return;
  browsing = true;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true });
    if (typeof selected === "string") onCloneBasePathChange?.(selected);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to open folder picker");
  } finally {
    browsing = false;
  }
}

function prCountFor(
  repo: { fullName: string },
  tracked: Repository | undefined,
): number | undefined {
  if (tracked) return openPrCountByRepoId.get(tracked.id) ?? 0;
  return getAvailablePrCount(repo.fullName) ?? (getAvailablePrCountsLoaded() ? 0 : undefined);
}
</script>

<Command.Root
	shouldFilter={false}
	loop
	class="add-repo flex h-auto min-h-0 flex-1 flex-col overflow-visible bg-transparent"
>
	{#if showTitle}
		<RepoDialogHeader title="Add Repository" meta={trackedCount > 0 ? `${trackedCount} tracked` : undefined} />
	{/if}

	<!-- Search (pinned). cmdk owns keyboard nav + selection. -->
	<div class="search-shell">
		<Command.Input
			bind:ref={searchEl}
			value={search}
			oninput={(e) => (search = e.currentTarget.value)}
			placeholder="Search or type owner/name…"
		/>
		<Button
			variant="ghost"
			size="icon-sm"
			class="refresh-btn"
			onclick={() => fetchAvailableRepos(true)}
			disabled={getAvailableReposLoading()}
			aria-label="Refresh repositories"
			title="Refresh repositories"
		>
			<RefreshCw class={getAvailableReposLoading() ? 'motion-essential-spin' : ''} />
		</Button>
	</div>

	{#if showLocation}
		<div class="location-row">
			<RepoField
				placeholder={getDefaultCloneBaseDir() ?? 'Default clone location'}
				aria-label="Clone location"
				value={cloneBasePath}
				oninput={(e) => onCloneBasePathChange?.(e.currentTarget.value)}
				autocomplete="off"
				spellcheck="false"
			>
				{#snippet icon()}<Folder size={13} />{/snippet}
			</RepoField>
			<Button
				variant="outline"
				size="sm"
				class="h-8 rounded-[var(--radius-card)]"
				onclick={() => void browseForCloneBase()}
				disabled={!runningInTauri || browsing}
				title="Browse for folder"
			>
				<Folder size={13} weight="fill" />
				<span>Browse</span>
			</Button>
		</div>
		{#if resolvedClonePath}
			<div class="resolved-path">
				<ArrowRight size={11} weight="bold" />
				<span>{resolvedClonePath}</span>
			</div>
		{/if}
	{/if}

	<Command.List class="add-repo-list">
		{#if listState === 'loading'}
			<div class="skeleton-list" aria-hidden="true">
				{#each [58, 44, 66, 38, 52] as width, i (i)}
					<div class="skeleton-row">
						<span class="sk sk-avatar"></span>
						<span class="sk sk-line" style="width: {width}%"></span>
					</div>
				{/each}
			</div>
			<span class="sr-only" role="status">Loading repositories…</span>
		{:else if listState === 'error'}
			<Command.Empty forceMount>
				<div class="state-block">
					<span>Couldn't load your repositories. Your GitHub session may have expired.</span>
					<Button variant="outline" size="sm" onclick={retryFetch}>
						<RefreshCw size={13} weight="fill" />
						<span>Retry</span>
					</Button>
				</div>
			</Command.Empty>
		{:else if listState === 'empty'}
			<Command.Empty forceMount>
				<div class="state-block">
					<span>No repositories available yet.</span>
					<Button variant="outline" size="sm" onclick={retryFetch}>
						<RefreshCw size={13} weight="fill" />
						<span>Refresh</span>
					</Button>
				</div>
			</Command.Empty>
		{/if}

		{#if showManualImport}
			<Command.Group>
				<Command.Item
					value={MANUAL_IMPORT_VALUE}
					keywords={[trimmedSearch]}
					disabled={isManualAlreadyTracked || isManualLoading}
					onSelect={() => void handleManualImport()}
					class="import-item"
				>
					<span class="import-icon" aria-hidden="true">
						{#if isManualLoading}
							<Spinner size={12} weight="bold" class="motion-essential-spin" />
						{:else}
							<Plus size={12} weight="bold" />
						{/if}
					</span>
					<div class="import-body">
						<span class="import-slug">{trimmedSearch}</span>
						<span class="import-hint">
							{#if isManualAlreadyTracked}
								Already tracked
							{:else if isManualLoading}
								Importing…
							{:else}
								Import this repository
							{/if}
						</span>
					</div>
				</Command.Item>
			</Command.Group>
		{/if}

		{#if listState === 'no-match' && !showManualImport}
			<Command.Empty forceMount>
				<div class="state-block state-block--hint">
					<span>No repositories match <em>“{trimmedSearch}”</em>.</span>
					<span class="state-hint">Tip: type <span class="kbd-inline">owner/name</span> to import any repo.</span>
				</div>
			</Command.Empty>
		{/if}

		{#if listState === 'groups'}
			{#each [...groupedByOwner] as [owner, repos] (owner)}
				<Command.Group value={owner}>
					{#snippet headingChild()}
						<OwnerAvatar
							name={owner}
							avatarUrl={repos[0]?.avatarUrl ?? null}
							size={16}
							radius={999}
							class="org-avatar"
						/>
						<span class="org-heading-name">{owner}</span>
					{/snippet}
					{#each repos as repo (repo.fullName)}
						{@const trackedRepo = trackedByFullName.get(repo.fullName)}
						{@const isTracked = trackedRepo !== undefined}
						{@const isAdding = addingRepos.has(repo.fullName)}
						{@const isRemoving = trackedRepo ? removingRepos.has(trackedRepo.id) : false}
						{@const prCount = prCountFor(repo, trackedRepo)}
						<Command.Item
							value={repo.fullName}
							keywords={[repo.name, repo.owner]}
							onSelect={() => {
								if (!isTracked && !isAdding) void handleAdd(repo.fullName);
							}}
							class={isTracked ? 'repo-item repo-item--tracked' : 'repo-item'}
						>
							<RepoGradientAvatar
								fullName={repo.fullName}
								ownerAvatarUrl={repo.avatarUrl}
								size={18}
								radius={999}
								class="repo-avatar"
							/>
							<span class="repo-name">{repo.name}</span>

							<div class="repo-meta">
								{#if isAdding}
									<Spinner size={13} weight="bold" class="motion-essential-spin text-accent" />
								{:else if isTracked && trackedRepo.cloneStatus !== 'ready'}
									<CloneStatusIndicator
										status={trackedRepo.cloneStatus}
										error={trackedRepo.cloneError}
										onRetry={() => retryClone(trackedRepo.id)}
										size={13}
										showLabel
									/>
								{:else if isTracked && !trackedRepo.managed}
									<Badge variant="secondary" class="meta-badge meta-badge--linked" title="Linked clone">
										<LinkSimple size={10} weight="bold" />
										Linked
									</Badge>
								{:else if isTracked}
									<Badge variant="secondary" class="meta-badge">Tracked</Badge>
								{:else if prCount !== undefined && prCount > 0}
									<span class="pr-count" title="{prCount} open pull request{prCount === 1 ? '' : 's'}">
										<GitPullRequest size={11} weight="bold" />
										{prCount}
									</span>
								{/if}

								{#if isTracked}
									<button
										type="button"
										class="remove-btn"
										onclick={(e) => {
											e.stopPropagation();
											repoPendingDelete = trackedRepo;
										}}
										disabled={isRemoving}
										aria-label="Remove {repo.fullName}"
										title="Remove {repo.fullName}"
									>
										{#if isRemoving}
											<Spinner size={11} weight="bold" class="motion-essential-spin" />
										{:else}
											<Trash2 size={11} weight="fill" />
										{/if}
									</button>
								{/if}
							</div>
						</Command.Item>
					{/each}
				</Command.Group>
			{/each}
		{/if}
	</Command.List>

	{#if onClose}
		<div class="footer">
			<Button variant="ghost" size="sm" onclick={onClose}>Done</Button>
		</div>
	{/if}
</Command.Root>

<RepoDeleteConfirm
	repo={repoPendingDelete}
	open={repoPendingDelete !== null}
	deleting={repoPendingDelete ? removingRepos.has(repoPendingDelete.id) : false}
	onOpenChange={(nextOpen) => {
		if (!nextOpen && (!repoPendingDelete || !removingRepos.has(repoPendingDelete.id))) {
			repoPendingDelete = null;
		}
	}}
	onConfirm={() => {
		if (repoPendingDelete) void handleRemove(repoPendingDelete.id);
	}}
/>

<style>
	/* ── Search (cmdk input restyled as a pill field) ───── */
	.search-shell {
		position: relative;
		flex-shrink: 0;
	}

	/* Restyle the shadcn command-input wrapper into the warm-paper pill the
	   rest of the add-repo surface uses, and clear its default bottom rule. */
	.search-shell :global([data-slot="command-input-wrapper"]) {
		height: 32px;
		gap: 7px;
		padding: 0 34px 0 11px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-input-bg);
		transition:
			border-color var(--duration-instant) var(--ease-soft),
			background var(--duration-instant) var(--ease-soft),
			box-shadow var(--duration-instant) var(--ease-soft);
	}

	.search-shell :global([data-slot="command-input-wrapper"]:focus-within) {
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
		background: var(--color-bg-primary);
		box-shadow: 0 0 0 3px var(--color-input-focus-ring);
	}

	.search-shell :global([data-slot="command-input-wrapper"] svg) {
		width: 13px;
		height: 13px;
		opacity: 1;
		color: var(--color-text-muted);
	}

	.search-shell :global([data-slot="command-input"]) {
		height: 100%;
		padding: 0;
		font-size: 12.5px;
		font-weight: 450;
		color: var(--color-text-primary);
	}

	.search-shell :global([data-slot="command-input"]::placeholder) {
		color: var(--color-text-muted);
	}

	.search-shell :global(.refresh-btn) {
		position: absolute;
		top: 50%;
		right: 3px;
		transform: translateY(-50%);
		color: var(--color-text-muted);
	}

	/* ── Location row ───────────────────────────────────── */
	.location-row {
		display: flex;
		gap: 6px;
		margin-top: 8px;
		flex-shrink: 0;
	}

	.resolved-path {
		display: flex;
		align-items: center;
		gap: 5px;
		margin: 6px 2px 0;
		color: var(--color-text-muted);
		font-size: 11px;
		flex-shrink: 0;
	}

	.resolved-path :global(svg) {
		flex-shrink: 0;
		opacity: 0.7;
	}

	.resolved-path span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ── List (the only scroll region) ──────────────────────
	   cmdk- and component-prop classes (.add-repo, .add-repo-list,
	   [data-command-*], .repo-item, .repo-avatar, .meta-badge) live on
	   elements that don't carry this component's scope hash (they're set via
	   child-component `class` props or generated by bits-ui), so these
	   selectors are fully `:global(...)`, mirroring CommandPalette. Own-DOM
	   layout classes below stay scoped. */
	:global(.add-repo .add-repo-list) {
		flex: 1;
		min-height: 0;
		max-height: none;
		margin: 8px 0 0;
		padding: 0 2px 4px;
		overflow-y: auto;
		overflow-x: hidden;
	}

	:global(.add-repo .add-repo-list)::-webkit-scrollbar {
		width: 8px;
	}
	:global(.add-repo .add-repo-list)::-webkit-scrollbar-thumb {
		background: var(--color-glass-border);
		border-radius: 4px;
		border: 2px solid transparent;
		background-clip: padding-box;
	}
	:global(.add-repo .add-repo-list)::-webkit-scrollbar-thumb:hover {
		background: var(--color-glass-active-bg);
		background-clip: padding-box;
	}

	/* ── Group + heading ────────────────────────────────── */
	:global(.add-repo [data-command-group]) {
		padding: 0;
	}

	:global(.add-repo [data-command-group] + [data-command-group]) {
		margin-top: 4px;
	}

	/* A plain section title — no scrim, no sticky. On the translucent modal any
	   opaque scrim reads as a foreign band, and a transparent sticky heading
	   would let rows scroll through it. So it scrolls inline and stands out
	   through weight + ink, not a background. */
	:global(.add-repo [data-command-group-heading]) {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 11px 10px 6px;
		font-size: 11.5px;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--color-text-primary);
		user-select: none;
	}

	:global(.add-repo .org-avatar) {
		flex-shrink: 0;
	}

	:global(.add-repo .org-heading-name) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ── Rows (cmdk items) ──────────────────────────────── */
	:global(.add-repo [data-command-item]) {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 7px 10px;
		border-radius: 8px;
		color: var(--color-text-primary);
		cursor: pointer;
		transition: background-color var(--duration-snap) var(--ease-soft);
	}

	:global(.add-repo [data-command-item][data-selected]),
	:global(.add-repo [data-command-item][aria-selected="true"]) {
		background: var(--color-tree-active-bg);
		color: var(--color-tree-active-text);
	}

	:global(.add-repo [data-command-item][data-disabled]) {
		opacity: 0.55;
		cursor: not-allowed;
	}

	:global(.add-repo .repo-item--tracked) {
		cursor: default;
	}

	:global(.add-repo .repo-avatar) {
		flex-shrink: 0;
	}

	:global(.add-repo .repo-name) {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.add-repo .repo-item--tracked .repo-name) {
		color: var(--color-text-secondary);
	}

	:global(.add-repo .repo-meta) {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	/* ── Manual-import row ──────────────────────────────── */
	:global(.add-repo .import-item) {
		align-items: flex-start;
		gap: 8px;
		padding: 8px 10px;
	}

	:global(.add-repo .import-icon) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		margin-top: 2px;
		color: var(--color-accent);
	}

	:global(.add-repo .import-body) {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	:global(.add-repo .import-slug) {
		font-size: 12px;
		font-weight: 500;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.add-repo .import-hint) {
		font-size: 11px;
		color: var(--color-text-muted);
		line-height: 1.4;
	}

	/* ── Right-side metadata ────────────────────────────── */
	:global(.add-repo .meta-badge) {
		height: 18px;
		padding: 0 7px;
		font-size: 10.5px;
		font-weight: 500;
	}

	:global(.add-repo .meta-badge--linked) {
		gap: 3px;
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-text-secondary);
	}

	:global(.add-repo .pr-count) {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--color-text-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	:global(.add-repo .pr-count svg) {
		opacity: 0.7;
	}

	:global(.add-repo [data-command-item][data-selected] .pr-count),
	:global(.add-repo [data-command-item][aria-selected="true"] .pr-count) {
		color: var(--color-tree-active-text);
	}

	:global(.add-repo .remove-btn) {
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
		opacity: 0.55;
		transition:
			color var(--duration-instant) var(--ease-soft),
			background var(--duration-instant) var(--ease-soft),
			opacity var(--duration-instant) var(--ease-soft);
	}

	:global(.add-repo [data-command-item]:hover .remove-btn),
	:global(.add-repo [data-command-item][aria-selected="true"] .remove-btn) {
		opacity: 1;
	}

	:global(.add-repo .remove-btn:hover:not(:disabled)) {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		opacity: 1;
	}

	:global(.add-repo .remove-btn:disabled) {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* ── State blocks (empty / error / no-match) ────────── */
	.state-block {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 36px 16px;
		font-size: 12px;
		color: var(--color-text-secondary);
		text-align: center;
	}

	.state-block--hint {
		gap: 6px;
		color: var(--color-text-muted);
	}

	.state-block--hint em {
		color: var(--color-text-secondary);
		font-style: italic;
	}

	.state-hint {
		font-size: 11px;
		opacity: 0.8;
	}

	.kbd-inline {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
		font-size: 10.5px;
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--color-glass-active-bg);
		color: var(--color-text-secondary);
	}

	/* ── Skeleton loading ───────────────────────────────── */
	.skeleton-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px 6px;
	}

	.skeleton-row {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 7px 10px;
	}

	.sk {
		background: var(--color-glass-active-bg);
		border-radius: 5px;
		position: relative;
		overflow: hidden;
	}

	.sk::after {
		content: "";
		position: absolute;
		inset: 0;
		background: linear-gradient(
			90deg,
			transparent,
			color-mix(in srgb, var(--color-text-primary) 6%, transparent),
			transparent
		);
		transform: translateX(-100%);
		animation: sk-shimmer 1.4s var(--ease-soft) infinite;
	}

	.sk-avatar {
		width: 18px;
		height: 18px;
		border-radius: 999px;
		flex-shrink: 0;
	}

	.sk-line {
		height: 9px;
	}

	@keyframes sk-shimmer {
		to {
			transform: translateX(100%);
		}
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@media (prefers-reduced-motion: reduce) {
		.sk::after {
			animation: none;
		}
	}

	/* ── Footer ─────────────────────────────────────────── */
	.footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		margin: 8px -20px 0;
		padding: 10px 20px 0;
		border-top: 1px solid var(--color-border-subtle);
		flex-shrink: 0;
	}
</style>
