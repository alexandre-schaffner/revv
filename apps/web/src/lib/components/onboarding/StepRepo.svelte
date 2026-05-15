<script lang="ts">
	import { untrack } from 'svelte';
	import { ChevronLeft } from '@lucide/svelte';
	import type { Repository } from '@revv/shared';
	import { Dotmatrix } from '$lib/components/ui/dotmatrix';
	import {
		addRepo,
		getRepositories,
		getAvailableRepos,
		getAvailableReposLoading,
		getAvailableReposFetchFailed,
		fetchAvailableRepos,
	} from '$lib/stores/prs.svelte';

	interface Props {
		onContinue: () => void;
		onBack?: () => void;
		onSkip?: () => void;
		isGhe?: boolean;
	}

	let { onContinue, onBack, onSkip, isGhe = false }: Props = $props();

	let search = $state('');
	let isAdding = $state(false);
	let addingRepoName = $state<string | null>(null);
	let waitingForClone = $state(false);
	let highlightedIndex = $state(0);
	let cloneTimeoutId = $state<ReturnType<typeof setTimeout> | null>(null);
	let skipWaitingTimeoutId = $state<ReturnType<typeof setTimeout> | null>(null);
	let showSkipWaiting = $state(false);

	function focusOnMount(node: HTMLInputElement) {
		// Wrapped in rAF so the focus call runs after the step animation
		// has begun — focusing while the parent is still mid-translate can
		// land the cursor at the wrong scroll position on some browsers.
		requestAnimationFrame(() => node.focus());
	}

	$effect(() => {
		if (getAvailableRepos().length === 0 && !getAvailableReposLoading() && !getAvailableReposFetchFailed()) {
			fetchAvailableRepos();
		}
	});

	// Pre-fill search with the most common org so the list is scoped
	$effect(() => {
		const repos = getAvailableRepos();
		if (repos.length === 0 || untrack(() => search) !== '') return;
		// Find the most common owner
		const counts = new Map<string, number>();
		for (const r of repos) {
			counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
		}
		let topOwner = '';
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
		if (status === 'ready' || status === 'error') {
			advanceFromClone();
		}
		return () => {
			if (cloneTimeoutId !== null) clearTimeout(cloneTimeoutId);
			if (skipWaitingTimeoutId !== null) clearTimeout(skipWaitingTimeoutId);
		};
	});

	function advanceFromClone() {
		if (cloneTimeoutId !== null) {
			clearTimeout(cloneTimeoutId);
			cloneTimeoutId = null;
		}
		if (skipWaitingTimeoutId !== null) {
			clearTimeout(skipWaitingTimeoutId);
			skipWaitingTimeoutId = null;
		}
		waitingForClone = false;
		isAdding = false;
		addingRepoName = null;
		showSkipWaiting = false;
		onContinue();
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
		addingRepoName = repo.fullName;
		waitingForClone = true;
		startCloneTimeouts();
		try {
			await addRepo(repo.fullName);
			// Don't advance here — the clone-status $effect handles it
		} catch {
			// If addRepo itself fails, stop waiting
			waitingForClone = false;
			isAdding = false;
			addingRepoName = null;
			if (cloneTimeoutId !== null) { clearTimeout(cloneTimeoutId); cloneTimeoutId = null; }
			if (skipWaitingTimeoutId !== null) { clearTimeout(skipWaitingTimeoutId); skipWaitingTimeoutId = null; }
			showSkipWaiting = false;
		}
	}

	async function submitManual(slug: string) {
		if (isAdding) return;
		isAdding = true;
		addingRepoName = slug;
		waitingForClone = true;
		startCloneTimeouts();
		try {
			await addRepo(slug);
		} catch {
			waitingForClone = false;
			isAdding = false;
			addingRepoName = null;
			if (cloneTimeoutId !== null) { clearTimeout(cloneTimeoutId); cloneTimeoutId = null; }
			if (skipWaitingTimeoutId !== null) { clearTimeout(skipWaitingTimeoutId); skipWaitingTimeoutId = null; }
			showSkipWaiting = false;
		}
	}

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlightedIndex = Math.min(highlightedIndex + 1, filtered.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlightedIndex = Math.max(highlightedIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const repo = filtered[highlightedIndex];
			if (repo) {
				void select(repo);
			} else if (search.includes('/') && !isGhe) {
				void submitManual(search.trim());
			}
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
			<p class="cloning-label">Cloning {addingRepoName}… this may take a moment.</p>
			{#if showSkipWaiting}
				<button class="skip-waiting" onclick={advanceFromClone}>Skip waiting →</button>
			{/if}
		</div>
	{:else}
		<div class="browse">
			<div class="search-row">
				<input
					class="search"
					type="text"
					placeholder={isGhe ? 'Search repositories…' : 'Search or enter owner/repo…'}
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
				{#if getAvailableReposLoading() && filtered.length === 0}
					<p class="empty">Loading repositories…</p>
				{:else if getAvailableReposFetchFailed() && filtered.length === 0}
					<p class="empty error-state">
						Could not load repositories — your GitHub session may have expired.
						<button class="retry-link" onclick={() => fetchAvailableRepos(true)}>Retry</button>
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

			{#if onSkip}
				<button class="skip" onclick={onSkip}>
					Skip for now
				</button>
			{/if}
		</div>
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
		animation: row-in 480ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
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
		animation: fade-in var(--duration-smooth, 400ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)) both;
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
