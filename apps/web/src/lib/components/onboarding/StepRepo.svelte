<script lang="ts">
import CaretLeft from "phosphor-svelte/lib/CaretLeft";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import FolderOpen from "phosphor-svelte/lib/FolderOpen";
import GithubLogo from "phosphor-svelte/lib/GithubLogo";
import LinkSimple from "phosphor-svelte/lib/LinkSimple";
import { untrack } from "svelte";
import { toastAddRepoError } from "$lib/components/shared/add-repo-toast";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import { gsapEnter, tokens } from "$lib/motion";
import { filterRepos, isRepoSlug, majorityOwner } from "$lib/repos/add-repo";
import { getTrackedRepo, LocalClone, useAvailableRepos } from "$lib/repos/add-repo.svelte";
import {
  type AvailableRepo,
  getAvailableRepos,
  getAvailableReposLoading,
} from "$lib/repos/catalog.svelte";
import { addRepo } from "$lib/stores/repos.svelte";

interface Props {
  onContinue: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  isGhe?: boolean;
}

let { onContinue, onBack, onSkip, isGhe = false }: Props = $props();

const catalog = useAvailableRepos();
const clone = new LocalClone();

const SHOW_SKIP_WAITING_AFTER_MS = 8000;
const FORCE_ADVANCE_AFTER_MS = 60000;

let mode = $state<"browse" | "link">("link");
let search = $state("");
let addingRepoName = $state<string | null>(null);
let addingMode = $state<"clone" | "link">("clone");
let highlightedIndex = $state(0);
let showSkipWaiting = $state(false);

const isAdding = $derived(addingRepoName !== null);

function focusOnMount(node: HTMLInputElement) {
  // Wrapped in rAF so the focus call runs after the step animation
  // has begun — focusing while the parent is still mid-translate can
  // land the cursor at the wrong scroll position on some browsers.
  requestAnimationFrame(() => node.focus());
}

// Pre-fill the search with an org that owns a clear majority of the user's
// repos, so the list starts scoped without confusing users with many
// personal repos.
$effect(() => {
  const repos = getAvailableRepos();
  if (repos.length === 0 || untrack(() => search) !== "") return;
  const owner = majorityOwner(repos);
  if (owner) search = owner;
});

// Advance once the repo being added is cloned (or failed). The clone can be
// slow, so after a while the user may skip waiting, and past a hard limit
// the step advances on its own.
const addingStatus = $derived(
  addingRepoName === null ? undefined : getTrackedRepo(addingRepoName)?.cloneStatus,
);

$effect(() => {
  if (addingStatus === "ready" || addingStatus === "error") untrack(advanceFromClone);
});

$effect(() => {
  if (addingRepoName === null) return;
  const skipTimer = setTimeout(() => (showSkipWaiting = true), SHOW_SKIP_WAITING_AFTER_MS);
  const advanceTimer = setTimeout(advanceFromClone, FORCE_ADVANCE_AFTER_MS);
  return () => {
    clearTimeout(skipTimer);
    clearTimeout(advanceTimer);
  };
});

function stopAdding(): void {
  addingRepoName = null;
  showSkipWaiting = false;
}

function advanceFromClone(): void {
  stopAdding();
  onContinue();
}

let canLink = $derived(clone.linkable && !isAdding);
let actionVerb = $derived(addingMode === "link" ? "Linking" : "Cloning");

let filtered = $derived(filterRepos(getAvailableRepos(), search).slice(0, 20));

$effect(() => {
  // Reset highlight when filter changes
  search;
  highlightedIndex = 0;
});

async function startAdding(
  name: string,
  addMode: "clone" | "link",
  run: () => Promise<void>,
): Promise<void> {
  addingMode = addMode;
  addingRepoName = name;
  try {
    await run();
  } catch (e) {
    toastAddRepoError(
      e,
      addMode === "link" ? "Failed to link repository" : "Failed to add repository",
    );
    stopAdding();
  }
}

function select(repo: AvailableRepo): void {
  if (isAdding) return;
  if (getTrackedRepo(repo.fullName)) {
    onSkip?.();
    return;
  }
  void startAdding(repo.fullName, "clone", () => addRepo(repo.fullName));
}

function submitManual(slug: string): void {
  if (isAdding) return;
  void startAdding(slug, "clone", () => addRepo(slug));
}

function submitLink(): void {
  const fullName = clone.fullName;
  if (!canLink || fullName === null) return;
  const clonePath = clone.path.trim();
  void startAdding(fullName, "link", () => addRepo({ fullName, mode: "link", clonePath }));
}

function browseLocalClone(): void {
  if (isAdding) return;
  void clone.browse();
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
    const slug = search.trim();
    if (repo) {
      select(repo);
    } else if (isRepoSlug(slug) && !isGhe) {
      submitManual(slug);
    }
  }
}

function handlePathKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    void clone.inspect();
  }
}
</script>

<div class="repo">
	{#if onBack && !isAdding && mode !== 'browse'}
		<button class="back" onclick={onBack}>
			<CaretLeft size={14} />
			<span>Back</span>
		</button>
	{/if}

	{#if isAdding && addingRepoName}
		<div class="cloning">
			<Dotmatrix variant="square-15" />
			<p class="cloning-label">{actionVerb} {addingRepoName}… this may take a moment.</p>
			{#if showSkipWaiting}
				<button class="skip-waiting" onclick={advanceFromClone} use:gsapEnter={{ duration: tokens.smooth }}>Skip waiting →</button>
			{/if}
		</div>
	{:else}
		{#if mode === 'link'}
			<div class="link">
				<div class="search-row link-path-row">
					<input
						class="search"
						type="text"
						placeholder="/Users/you/code/project"
						aria-label="Local clone path"
						bind:value={clone.path}
						onblur={() => void clone.inspect()}
						onkeydown={handlePathKey}
						use:focusOnMount
						autocomplete="off"
						spellcheck="false"
					/>
					{#if clone.inspecting}
						<Dotmatrix variant="square-13" size="small" />
					{/if}
					<button class="browse-button" onclick={browseLocalClone} disabled={clone.inspecting}>
						<FolderOpen size={13} />
						<span>Browse</span>
					</button>
				</div>

				{#if clone.isGitRepo === false}
					<p class="path-hint path-hint--danger">The selected folder is not a git repository.</p>
				{:else if clone.alreadyTracked}
					<p class="path-hint path-hint--danger">This repository is already tracked.</p>
				{:else if clone.isGitRepo === true && clone.fullName !== null}
					<p class="path-hint path-hint--ok">
						<CheckCircle size={12} />
						<span>Recognized as <code>{clone.fullName}</code>.</span>
					</p>
				{:else if clone.isGitRepo === true}
					<p class="path-hint path-hint--danger">
						This clone's <code>origin</code> remote doesn't point at a repository on this GitHub host.
					</p>
				{:else if clone.remotes.length > 0}
					<div class="remote-list">
						{#each clone.remotes.slice(0, 3) as remote (`${remote.name}-${remote.url}`)}
							<div class="remote-row">
								<span>{remote.name}</span>
								<code>{remote.url}</code>
							</div>
						{/each}
					</div>
				{:else}
					<p class="path-hint">Choose a local checkout. Revv detects the GitHub repository from its origin remote.</p>
				{/if}

				{#if canLink}
					<!-- A linkable clone is recognized: the Link button is the
					     primary action, so the GitHub-clone path recedes to a
					     quiet inline alternative beside it rather than competing
					     as a full-width card. -->
					<div class="link-actions">
						<button class="link-submit" onclick={submitLink}>
							<LinkSimple size={14} />
							<span>Link this repository</span>
						</button>
						<button class="alt-link" onclick={() => (mode = 'browse')}>
							<span>or clone from GitHub instead</span>
							<span class="alt-link-arrow" aria-hidden="true">→</span>
						</button>
					</div>

					{#if onSkip}
						<div class="repo-actions">
							<button class="skip" onclick={onSkip}>
								Skip for now
							</button>
						</div>
					{/if}
				{:else}
					<!-- No linkable clone yet: the GitHub-clone path is the only
					     actionable choice on screen, so it earns the full card. -->
					<div class="repo-actions">
						<button class="alt-path" onclick={() => (mode = 'browse')}>
							<GithubLogo size={17} />
							<span class="alt-path-text">
								<span class="alt-path-title">Clone a repository from GitHub instead</span>
								<span class="alt-path-sub">Browse and clone any repository you can access</span>
							</span>
							<span class="alt-path-arrow" aria-hidden="true">→</span>
						</button>
						{#if onSkip}
							<button class="skip" onclick={onSkip}>
								Skip for now
							</button>
						{/if}
					</div>
				{/if}
			</div>
		{:else}
			<div class="browse">
				<button class="back-mode" onclick={() => (mode = 'link')}>
					<CaretLeft size={13} />
					<span>Back</span>
				</button>

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
					{#if catalog.loading && filtered.length === 0}
						<p class="empty">Loading repositories…</p>
					{:else if catalog.failed && filtered.length === 0}
						<p class="empty error-state">
							Could not load repositories — your GitHub session may have expired.
							<button class="retry-link" onclick={catalog.retry}>Retry</button>
						</p>
					{:else if filtered.length === 0}
						<p class="empty">No repositories match "{search}"</p>
					{:else}
						{#each filtered as repo, i (repo.fullName)}
							{@const isHighlighted = i === highlightedIndex}
							{@const isTracked = getTrackedRepo(repo.fullName) !== undefined}
							{@const isThisAdding = addingRepoName === repo.fullName}
							<button
								class="row"
								data-highlighted={isHighlighted}
								data-tracked={isTracked}
								onclick={() => select(repo)}
								onmouseenter={() => (highlightedIndex = i)}
								disabled={isAdding}
								use:gsapEnter={{ y: 4, delay: Math.min(i, 8) * 0.03 }}
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

				{#if onSkip}
					<div class="repo-actions">
						<button class="skip" onclick={onSkip}>
							Skip for now
						</button>
					</div>
				{/if}
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

	.back-mode {
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
	}

	.back-mode:hover {
		color: var(--ob-text-italic);
	}

	.back-mode :global(svg) {
		transition: transform var(--duration-quick) var(--ease-out-expo);
	}

	.back-mode:hover :global(svg) {
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
		border: 1px solid var(--ob-border-btn);
		border-radius: 2px;
		background: transparent;
		padding: 7px 11px;
		color: var(--ob-text-label);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			color var(--duration-snap) var(--ease-out-expo),
			border-color var(--duration-snap) var(--ease-out-expo);
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

	.repo-actions {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 14px;
	}

	.link-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-start;
		gap: 18px;
	}

	.alt-link {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		background: none;
		border: 0;
		padding: 4px 2px;
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 14.5px;
		color: var(--ob-text-muted);
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.alt-link:hover {
		color: var(--ob-text-italic);
	}

	.alt-link-arrow {
		font-size: 15px;
		color: var(--ob-text-dimmed);
		transition:
			transform var(--duration-smooth) var(--ease-out-expo),
			color var(--duration-snap) var(--ease-out-expo);
	}

	.alt-link:hover .alt-link-arrow {
		transform: translateX(3px);
		color: var(--ob-text-italic);
	}

	.alt-path {
		display: flex;
		align-items: center;
		gap: 14px;
		width: 100%;
		padding: 14px 16px;
		border: 1px solid var(--ob-border);
		border-radius: 2px;
		background: transparent;
		text-align: left;
		cursor: pointer;
		transition:
			border-color var(--duration-snap) var(--ease-out-expo),
			background-color var(--duration-snap) var(--ease-out-expo),
			transform var(--duration-smooth) var(--ease-out-expo);
	}

	.alt-path :global(svg) {
		flex-shrink: 0;
		color: var(--ob-text-label);
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.alt-path-text {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.alt-path-title {
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 16px;
		font-weight: 500;
		letter-spacing: 0.01em;
		color: var(--ob-text-heading);
	}

	.alt-path-sub {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10px;
		letter-spacing: 0.08em;
		color: var(--ob-text-muted);
	}

	.alt-path-arrow {
		margin-left: auto;
		font-family: 'Newsreader', Georgia, serif;
		font-size: 18px;
		color: var(--ob-text-dimmed);
		transition:
			transform var(--duration-smooth) var(--ease-out-expo),
			color var(--duration-snap) var(--ease-out-expo);
	}

	.alt-path:hover {
		border-color: var(--ob-text-italic);
		background: var(--ob-hover-subtle);
	}

	.alt-path:hover :global(svg),
	.alt-path:hover .alt-path-arrow {
		color: var(--ob-text-italic);
	}

	.alt-path:hover .alt-path-arrow {
		transform: translateX(4px);
	}

	.alt-path:active {
		transform: scale(0.99);
	}

	.skip {
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

	.repo-actions .skip {
		align-self: flex-end;
	}

	.skip:hover {
		color: var(--ob-text-label);
	}

	/* Matches the onboarding primary CTA (StepWelcome / StepHost). */
	.link-submit {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 11px 20px;
		border: 1px solid var(--ob-border-btn);
		border-radius: 2px;
		background: transparent;
		color: var(--ob-text-heading);
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 16px;
		font-weight: 500;
		letter-spacing: 0.01em;
		cursor: pointer;
		transition:
			border-color var(--duration-snap) var(--ease-out-expo),
			color var(--duration-snap) var(--ease-out-expo),
			background-color var(--duration-snap) var(--ease-out-expo),
			transform var(--duration-smooth) var(--ease-out-expo);
	}

	.link-submit :global(svg) {
		color: var(--ob-text-label);
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.link-submit:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.link-submit:not(:disabled):hover {
		border-color: var(--ob-text-italic);
		color: var(--ob-text-heading-bright);
	}

	.link-submit:not(:disabled):hover :global(svg) {
		color: var(--ob-text-italic);
	}

	.link-submit:not(:disabled):active {
		transform: scale(0.99);
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
	}

	.skip-waiting:hover {
		color: var(--ob-text-italic);
	}
</style>
