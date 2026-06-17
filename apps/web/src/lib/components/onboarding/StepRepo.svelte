<script lang="ts">
import type { Repository } from "@revv/shared";
import ChevronLeft from "phosphor-svelte/lib/CaretLeft";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import FolderOpen from "phosphor-svelte/lib/FolderOpen";
import LinkSimple from "phosphor-svelte/lib/LinkSimple";
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import {
  addRepo,
  fetchAvailableRepos,
  getAvailableRepos,
  getAvailableReposFetchFailed,
  getAvailableReposLoading,
  getRepositories,
} from "$lib/stores/prs.svelte";
import { isTauri } from "$lib/utils/platform";

interface Props {
  onContinue: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  isGhe?: boolean;
}

let { onContinue, onBack, onSkip, isGhe = false }: Props = $props();

const runningInTauri = isTauri();

let mode = $state<"browse" | "link">("browse");
let search = $state("");
let isAdding = $state(false);
let addingRepoName = $state<string | null>(null);
let addingMode = $state<"clone" | "link">("clone");
let waitingForClone = $state(false);
let highlightedIndex = $state(0);
let cloneTimeoutId = $state<ReturnType<typeof setTimeout> | null>(null);
let skipWaitingTimeoutId = $state<ReturnType<typeof setTimeout> | null>(null);
let showSkipWaiting = $state(false);
let autoRetries = $state(0);
let clonePath = $state("");
let inspectedPath = $state<string | null>(null);
let inspecting = $state(false);
let remotes = $state<{ name: string; url: string }[]>([]);
let isGitRepo = $state<boolean | null>(null);
let fullName = $state<string | null>(null);
const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 2000;

function focusOnMount(node: HTMLInputElement) {
  // Wrapped in rAF so the focus call runs after the step animation
  // has begun — focusing while the parent is still mid-translate can
  // land the cursor at the wrong scroll position on some browsers.
  requestAnimationFrame(() => node.focus());
}

$effect(() => {
  if (
    getAvailableRepos().length === 0 &&
    !getAvailableReposLoading() &&
    !getAvailableReposFetchFailed()
  ) {
    fetchAvailableRepos();
  }
});

// Auto-retry: after a fresh sign-in the GitHub token may not be fully
// propagated yet, or the server may briefly 401 during the race between
// setToken() and loadUser(). Retry a few times with a delay before
// falling back to the manual "Retry" button.
$effect(() => {
  if (!getAvailableReposFetchFailed()) return;
  if (autoRetries >= MAX_AUTO_RETRIES) return;
  const timer = setTimeout(() => {
    autoRetries++;
    fetchAvailableRepos(true);
  }, AUTO_RETRY_DELAY_MS);
  return () => clearTimeout(timer);
});

// Pre-fill search with the most common org so the list is scoped
$effect(() => {
  const repos = getAvailableRepos();
  if (repos.length === 0 || untrack(() => search) !== "") return;
  // Find the most common owner
  const counts = new Map<string, number>();
  for (const r of repos) {
    counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  }
  let topOwner = "";
  let topCount = 0;
  for (const [owner, count] of counts) {
    if (count > topCount) {
      topOwner = owner;
      topCount = count;
    }
  }
  // Only pre-fill if the top org owns a clear majority (>50% of repos)
  // to avoid confusing pre-selection when the user has many personal repos
  if (topOwner && topCount > repos.length / 2) {
    search = topOwner;
  }
});

// Watch clone status and advance (or unblock) once the repo is ready or errored.
$effect(() => {
  if (!waitingForClone || !addingRepoName) return;
  const repos = getRepositories();
  const added = repos.find((r) => r.fullName === addingRepoName);
  if (!added) return;
  const status = added.cloneStatus;
  if (status === "ready" || status === "error") {
    advanceFromClone();
  }
  return () => {
    if (cloneTimeoutId !== null) clearTimeout(cloneTimeoutId);
    if (skipWaitingTimeoutId !== null) clearTimeout(skipWaitingTimeoutId);
  };
});

function advanceFromClone() {
  clearCloneTimers();
  waitingForClone = false;
  isAdding = false;
  addingRepoName = null;
  showSkipWaiting = false;
  onContinue();
}

function clearCloneTimers() {
  if (cloneTimeoutId !== null) {
    clearTimeout(cloneTimeoutId);
    cloneTimeoutId = null;
  }
  if (skipWaitingTimeoutId !== null) {
    clearTimeout(skipWaitingTimeoutId);
    skipWaitingTimeoutId = null;
  }
}

function resetAddingAfterFailure() {
  waitingForClone = false;
  isAdding = false;
  addingRepoName = null;
  showSkipWaiting = false;
  clearCloneTimers();
}

function startCloneTimeouts() {
  skipWaitingTimeoutId = setTimeout(() => {
    showSkipWaiting = true;
  }, 8000);
  cloneTimeoutId = setTimeout(() => {
    advanceFromClone();
  }, 60000);
}

let tracked = $derived(new Set(getRepositories().map((r) => r.fullName)));
let alreadyTracked = $derived(fullName !== null && tracked.has(fullName));
let canLink = $derived(
  clonePath.trim() !== "" &&
    inspectedPath === clonePath.trim() &&
    fullName !== null &&
    isGitRepo === true &&
    !alreadyTracked &&
    !isAdding &&
    !inspecting,
);
let actionVerb = $derived(addingMode === "link" ? "Linking" : "Cloning");

let filtered = $derived.by(() => {
  const term = search.trim().toLowerCase();
  const repos = getAvailableRepos();
  if (!term) return repos.slice(0, 20);
  return repos
    .filter(
      (r) =>
        r.fullName.toLowerCase().includes(term) ||
        r.owner.toLowerCase().includes(term) ||
        r.name.toLowerCase().includes(term),
    )
    .slice(0, 20);
});

$effect(() => {
  // Reset highlight when filter changes
  search;
  highlightedIndex = 0;
});

async function select(repo: Repository) {
  if (isAdding) return;
  if (tracked.has(repo.fullName)) {
    onSkip?.();
    return;
  }
  isAdding = true;
  addingMode = "clone";
  addingRepoName = repo.fullName;
  waitingForClone = true;
  startCloneTimeouts();
  try {
    await addRepo(repo.fullName);
    // Don't advance here — the clone-status $effect handles it
  } catch (e) {
    // If addRepo itself fails, stop waiting
    toast.error(e instanceof Error ? e.message : "Failed to add repository");
    resetAddingAfterFailure();
  }
}

async function submitManual(slug: string) {
  if (isAdding) return;
  isAdding = true;
  addingMode = "clone";
  addingRepoName = slug;
  waitingForClone = true;
  startCloneTimeouts();
  try {
    await addRepo(slug);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to add repository");
    resetAddingAfterFailure();
  }
}

async function inspectPath(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) {
    resetInspection();
    return;
  }
  inspecting = true;
  try {
    const { data, error } = await api.api.repos["inspect-local"].post({ path: trimmed });
    if (error) {
      const value = error.value as { error?: string; message?: string } | undefined;
      throw new Error(value?.error ?? value?.message ?? "Failed to inspect local repository");
    }
    if (!data || "error" in data) {
      throw new Error("Failed to inspect local repository");
    }
    isGitRepo = data.isGitRepo;
    remotes = [...data.remotes];
    fullName = data.proposedFullName;
    inspectedPath = trimmed;
    if (!data.isGitRepo) {
      toast.error("Choose a folder that contains a git repository");
    }
  } catch (e) {
    resetInspection();
    toast.error(e instanceof Error ? e.message : "Failed to inspect local repository");
  } finally {
    inspecting = false;
  }
}

function resetInspection(): void {
  inspectedPath = null;
  fullName = null;
  remotes = [];
  isGitRepo = null;
}

function handlePathInput(e: Event): void {
  if (!(e.currentTarget instanceof HTMLInputElement)) return;
  if (inspectedPath !== null && e.currentTarget.value.trim() !== inspectedPath) {
    resetInspection();
  }
}

async function browseLocalClone(): Promise<void> {
  if (!runningInTauri || inspecting || isAdding) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true });
    if (typeof selected !== "string") return;
    clonePath = selected;
    await inspectPath(selected);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to open folder picker");
  }
}

async function submitLink(): Promise<void> {
  if (!canLink || fullName === null) return;
  const path = clonePath.trim();
  isAdding = true;
  addingMode = "link";
  addingRepoName = fullName;
  waitingForClone = true;
  startCloneTimeouts();
  try {
    await addRepo({ fullName, mode: "link", clonePath: path });
    // Don't advance here — the clone-status $effect handles linked repos too.
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to link repository");
    resetAddingAfterFailure();
  }
}

function handleKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlightedIndex = Math.min(highlightedIndex + 1, filtered.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlightedIndex = Math.max(highlightedIndex - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const repo = filtered[highlightedIndex];
    if (repo) {
      void select(repo);
    } else if (search.includes("/") && !isGhe) {
      void submitManual(search.trim());
    }
  }
}

function handlePathKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    void inspectPath(clonePath);
  }
}
</script>

<div class="repo">
	{#if onBack && !isAdding}
		<button class="back" onclick={onBack}>
			<ChevronLeft size={14} />
			<span>Back</span>
		</button>
	{/if}

	{#if isAdding && addingRepoName}
		<div class="cloning">
			<Dotmatrix variant="square-15" />
			<p class="cloning-label">{actionVerb} {addingRepoName}… this may take a moment.</p>
			{#if showSkipWaiting}
				<button class="skip-waiting" onclick={advanceFromClone}>Skip waiting →</button>
			{/if}
		</div>
	{:else}
		{#if mode === 'browse'}
			<div class="browse">
			<div class="search-row">
				<input
					class="search"
					type="text"
					placeholder={isGhe ? 'Search repositories…' : 'Search or enter owner/repo…'}
					aria-label="Search repositories"
					bind:value={search}
					onkeydown={handleKey}
					use:focusOnMount
					autocomplete="off"
					spellcheck="false"
				/>
				{#if getAvailableReposLoading()}
					<Dotmatrix variant="square-13" size="small" />
				{/if}
			</div>

			<div class="list" role="listbox">
				{#if (getAvailableReposLoading() || (getAvailableReposFetchFailed() && autoRetries < MAX_AUTO_RETRIES)) && filtered.length === 0}
					<p class="empty">Loading repositories…</p>
				{:else if getAvailableReposFetchFailed() && filtered.length === 0}
					<p class="empty error-state">
						Could not load repositories — your GitHub session may have expired.
						<button class="retry-link" onclick={() => { autoRetries = 0; fetchAvailableRepos(true); }}>Retry</button>
					</p>
				{:else if filtered.length === 0}
					<p class="empty">No repositories match "{search}"</p>
				{:else}
					{#each filtered as repo, i (repo.fullName)}
						{@const isHighlighted = i === highlightedIndex}
						{@const isTracked = tracked.has(repo.fullName)}
						{@const isThisAdding = addingRepoName === repo.fullName}
						<button
							class="row"
							data-highlighted={isHighlighted}
							data-tracked={isTracked}
							onclick={() => select(repo)}
							onmouseenter={() => (highlightedIndex = i)}
							disabled={isAdding}
							style="animation-delay: {Math.min(i, 8) * 30}ms"
						>
							<span class="row-owner">{repo.owner}</span>
							<span class="row-slash">/</span>
							<span class="row-name">{repo.name}</span>
							<span class="row-status">
								{#if isThisAdding}
									<Dotmatrix variant="square-2" size="small" />
								{:else if isTracked}
									tracked
								{/if}
							</span>
						</button>
					{/each}
				{/if}
			</div>

				<div class="repo-actions">
					<button class="skip" onclick={() => (mode = 'link')}>
						Open an existing clone instead →
					</button>
					{#if onSkip}
						<button class="skip" onclick={onSkip}>
							Skip for now
						</button>
					{/if}
				</div>
			</div>
		{:else}
			<div class="link">
				<div class="search-row link-path-row">
					<input
						class="search"
						type="text"
						placeholder="/Users/you/code/project"
						aria-label="Local clone path"
						bind:value={clonePath}
						oninput={handlePathInput}
						onblur={() => void inspectPath(clonePath)}
						onkeydown={handlePathKey}
						use:focusOnMount
						autocomplete="off"
						spellcheck="false"
					/>
					{#if inspecting}
						<Dotmatrix variant="square-13" size="small" />
					{/if}
					{#if runningInTauri}
						<button class="browse-button" onclick={() => void browseLocalClone()} disabled={inspecting}>
							<FolderOpen size={13} weight="fill" />
							<span>Browse</span>
						</button>
					{/if}
				</div>

				{#if isGitRepo === false}
					<p class="path-hint path-hint--danger">The selected folder is not a git repository.</p>
				{:else if alreadyTracked}
					<p class="path-hint path-hint--danger">This repository is already tracked.</p>
				{:else if isGitRepo === true && fullName !== null}
					<p class="path-hint path-hint--ok">
						<CheckCircle size={12} weight="fill" />
						<span>Recognized as <code>{fullName}</code>.</span>
					</p>
				{:else if isGitRepo === true}
					<p class="path-hint path-hint--danger">
						This clone's <code>origin</code> remote doesn't point at a repository on this GitHub host.
					</p>
				{:else if remotes.length > 0}
					<div class="remote-list">
						{#each remotes.slice(0, 3) as remote (`${remote.name}-${remote.url}`)}
							<div class="remote-row">
								<span>{remote.name}</span>
								<code>{remote.url}</code>
							</div>
						{/each}
					</div>
				{:else}
					<p class="path-hint">Choose a local checkout. Revv detects the GitHub repository from its origin remote.</p>
				{/if}

				<div class="link-actions">
					<button class="skip" onclick={() => (mode = 'browse')}>Back</button>
					<button class="link-submit" onclick={() => void submitLink()} disabled={!canLink}>
						<LinkSimple size={13} weight="bold" />
						<span>Link this repository</span>
					</button>
				</div>
			</div>
		{/if}
	{/if}

</div>

<style>
	.repo {
		display: flex;
		flex-direction: column;
		gap: 22px;
		width: 100%;
		max-width: 520px;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		background: none;
		border: 0;
		padding: 0;
		color: var(--ob-text-muted);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo);
		margin-bottom: -6px;
	}

	.back:hover {
		color: var(--ob-text-italic);
	}

	.back :global(svg) {
		transition: transform var(--duration-quick) var(--ease-out-expo);
	}

	.back:hover :global(svg) {
		transform: translateX(-3px);
	}

	.cloning {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 16px;
		padding: 8px 0;
	}

	.cloning-label {
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 17px;
		color: var(--ob-text-label);
		margin: 0;
	}

	.browse {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.link {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.search-row {
		display: flex;
		align-items: center;
		gap: 12px;
		border-bottom: 1px solid var(--ob-border);
		padding: 6px 0 10px;
	}

	.search {
		flex: 1;
		background: transparent;
		border: 0;
		outline: 0;
		font-family: 'Newsreader', Georgia, serif;
		font-size: 19px;
		color: var(--ob-text-heading);
		padding: 6px 0;
	}

	.search::placeholder {
		color: var(--ob-text-muted);
		font-style: italic;
	}

	.link-path-row {
		align-items: stretch;
	}

	.link-path-row .search {
		min-width: 0;
	}

	.browse-button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: center;
		border: 1px solid var(--ob-border);
		border-radius: 999px;
		background: transparent;
		padding: 6px 10px;
		color: var(--ob-text-label);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
	}

	.browse-button:disabled {
		cursor: default;
		opacity: 0.5;
	}

	.browse-button:not(:disabled):hover {
		color: var(--ob-text-italic);
		border-color: var(--ob-text-dimmed);
	}

	.list {
		display: flex;
		flex-direction: column;
		max-height: 320px;
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--ob-border) transparent;
	}

	.empty {
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 14px;
		color: var(--ob-text-muted);
		text-align: left;
		padding: 24px 0;
		margin: 0;
	}

	.empty.error-state {
		color: var(--ob-error);
	}

	.retry-link {
		background: none;
		border: none;
		padding: 0;
		margin-left: 4px;
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 14px;
		color: var(--ob-text-label);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.retry-link:hover {
		color: var(--ob-text-italic);
	}

	.row {
		display: flex;
		align-items: baseline;
		gap: 6px;
		padding: 12px 6px;
		background: transparent;
		border: 0;
		border-bottom: 1px solid var(--ob-border-subtle);
		color: var(--ob-text-row);
		font-family: 'Newsreader', Georgia, serif;
		font-size: 17px;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--duration-snap) var(--ease-out-expo);
		animation: row-in var(--duration-ceremonial-medium) var(--ease-out-expo) backwards;
	}

	@keyframes row-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.row[data-highlighted='true'] {
		background: var(--ob-row-highlight);
	}

	.row[data-tracked='true'] {
		opacity: 0.45;
	}

	.row-owner {
		color: var(--ob-text-label);
	}

	.row-slash {
		color: var(--ob-text-dimmed);
	}

	.row-name {
		color: var(--ob-text-heading);
		font-style: italic;
	}

	.row-status {
		margin-left: auto;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-style: normal;
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ob-text-muted);
		display: inline-flex;
		align-items: center;
	}

	.path-hint {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: -4px 0 0;
		color: var(--ob-text-muted);
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 14px;
		line-height: 1.45;
	}

	.path-hint :global(svg) {
		flex-shrink: 0;
	}

	.path-hint code,
	.remote-row code {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-style: normal;
		font-size: 11px;
	}

	.path-hint--danger {
		color: var(--ob-error);
	}

	.path-hint--ok {
		color: var(--ob-text-label);
	}

	.path-hint--ok code {
		color: var(--ob-text-heading);
	}

	.remote-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: -4px;
	}

	.remote-row {
		display: grid;
		grid-template-columns: 58px minmax(0, 1fr);
		gap: 8px;
		align-items: center;
		color: var(--ob-text-muted);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
	}

	.remote-row code {
		overflow: hidden;
		color: var(--ob-text-label);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.repo-actions,
	.link-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 12px;
	}

	.skip {
		align-self: flex-end;
		background: none;
		border: 0;
		padding: 6px 0;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ob-text-dimmed);
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.skip:hover {
		color: var(--ob-text-label);
	}

	.link-submit {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		border: 1px solid var(--ob-text-label);
		border-radius: 999px;
		background: var(--ob-text-heading);
		padding: 8px 13px;
		color: var(--ob-surface, #faf9f6);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
	}

	.link-submit:disabled {
		border-color: var(--ob-border);
		background: transparent;
		color: var(--ob-text-dimmed);
		cursor: default;
	}

	.link-submit:not(:disabled):hover {
		background: var(--ob-text-label);
	}

	.skip-waiting {
		background: none;
		border: 0;
		padding: 4px 0;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ob-text-dimmed);
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo);
		animation: fade-in var(--duration-smooth) var(--ease-out-expo) both;
	}

	.skip-waiting:hover {
		color: var(--ob-text-italic);
	}

	@keyframes fade-in {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	@media (prefers-reduced-motion: reduce) {
		.row {
			animation: none;
		}
	}
</style>
