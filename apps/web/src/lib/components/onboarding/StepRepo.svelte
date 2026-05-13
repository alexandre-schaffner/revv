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
	}

	let { onContinue, onBack }: Props = $props();

	let search = $state('');
	let isAdding = $state(false);
	let addingRepoName = $state<string | null>(null);
	let waitingForClone = $state(false);
	let mode = $state<'browse' | 'manual'>('browse');
	let manualValue = $state('');
	let manualError = $state('');
	let highlightedIndex = $state(0);

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
			waitingForClone = false;
			isAdding = false;
			addingRepoName = null;
			onContinue();
		}
	});

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
		if (isAdding || tracked.has(repo.fullName)) return;
		isAdding = true;
		addingRepoName = repo.fullName;
		waitingForClone = true;
		try {
			await addRepo(repo.fullName);
			// Don't advance here — the clone-status $effect handles it
		} catch {
			// If addRepo itself fails, stop waiting
			waitingForClone = false;
			isAdding = false;
			addingRepoName = null;
		}
	}

	async function submitManual() {
		const trimmed = manualValue.trim();
		if (!trimmed.includes('/')) {
			manualError = 'Use owner/name format.';
			return;
		}
		manualError = '';
		isAdding = true;
		addingRepoName = trimmed;
		waitingForClone = true;
		try {
			await addRepo(trimmed);
		} catch (e) {
			manualError = e instanceof Error ? e.message : 'Could not add repository.';
			waitingForClone = false;
			isAdding = false;
			addingRepoName = null;
		}
	}

	function handleKey(e: KeyboardEvent) {
		if (mode !== 'browse') return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlightedIndex = Math.min(highlightedIndex + 1, filtered.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlightedIndex = Math.max(highlightedIndex - 1, 0);
		} else if (e.key === 'Enter') {
			const repo = filtered[highlightedIndex];
			if (repo) {
				e.preventDefault();
				void select(repo);
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
		</div>
	{:else if mode === 'browse'}
		<div class="browse">
			<div class="search-row">
				<input
					class="search"
					type="text"
					placeholder="Search repositories…"
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
							disabled={isAdding || isTracked}
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

			<button class="mode-toggle" onclick={() => (mode = 'manual')}>
				or paste a repository slug
			</button>
		</div>
	{:else}
		<div class="manual">
			<div class="manual-row">
				<span class="manual-prefix">https://{'…'}/</span>
				<input
					class="manual-input"
					type="text"
					placeholder="owner/repository"
					bind:value={manualValue}
					onkeydown={(e) => {
						if (e.key === 'Enter') submitManual();
					}}
					use:focusOnMount
					autocomplete="off"
					spellcheck="false"
				/>
			</div>
			{#if manualError}
				<p class="error">{manualError}</p>
			{/if}

			<div class="manual-actions">
				<button class="mode-toggle" onclick={() => (mode = 'browse')}>
					back to list
				</button>
				<button class="primary" onclick={submitManual} disabled={isAdding}>
					<span>{isAdding ? 'Connecting…' : 'Connect'}</span>
					{#if !isAdding}
						<svg
							width="18"
							height="10"
							viewBox="0 0 18 10"
							fill="none"
							xmlns="http://www.w3.org/2000/svg"
							aria-hidden="true"
						>
							<path
								d="M0 5h16M12 1l4 4-4 4"
								stroke="currentColor"
								stroke-width="1"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					{/if}
				</button>
			</div>
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
		color: #6f6c63;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--duration-quick, 240ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
		margin-bottom: -6px;
	}

	.back:hover {
		color: #d4cab2;
	}

	.back :global(svg) {
		transition: transform var(--duration-quick, 240ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
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
		color: #8a8880;
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
		border-bottom: 1px solid #2a2925;
		padding: 6px 0 10px;
	}

	.search {
		flex: 1;
		background: transparent;
		border: 0;
		outline: 0;
		font-family: 'Newsreader', Georgia, serif;
		font-size: 19px;
		color: #f0ede4;
		padding: 6px 0;
	}

	.search::placeholder {
		color: #6f6c63;
		font-style: italic;
	}

	.list {
		display: flex;
		flex-direction: column;
		max-height: 320px;
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: #2a2925 transparent;
	}

	.empty {
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 14px;
		color: #6f6c63;
		text-align: left;
		padding: 24px 0;
		margin: 0;
	}

	.empty.error-state {
		color: #c98a8a;
	}

	.retry-link {
		background: none;
		border: none;
		padding: 0;
		margin-left: 4px;
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 14px;
		color: #8a8880;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
		transition: color var(--duration-quick, 240ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
	}

	.retry-link:hover {
		color: #d4cab2;
	}

	.row {
		display: flex;
		align-items: baseline;
		gap: 6px;
		padding: 12px 6px;
		background: transparent;
		border: 0;
		border-bottom: 1px solid #1b1a18;
		color: #d4d1c6;
		font-family: 'Newsreader', Georgia, serif;
		font-size: 17px;
		text-align: left;
		cursor: pointer;
		transition: background-color 220ms cubic-bezier(0.16, 1, 0.3, 1);
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
		background: rgba(212, 202, 178, 0.05);
	}

	.row[data-tracked='true'] {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.row-owner {
		color: #8a8678;
	}

	.row-slash {
		color: #4a4842;
	}

	.row-name {
		color: #f0ede4;
		font-style: italic;
	}

	.row-status {
		margin-left: auto;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-style: normal;
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: #6f6c63;
		display: inline-flex;
		align-items: center;
	}

	.mode-toggle {
		align-self: flex-start;
		background: none;
		border: 0;
		padding: 6px 0;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: #6f6c63;
		cursor: pointer;
		transition: color 280ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.mode-toggle:hover {
		color: #d4cab2;
	}

	/* ── Manual mode ─────────────────────────────────────────────── */
	.manual {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.manual-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		border-bottom: 1px solid #2a2925;
		padding: 10px 0;
	}

	.manual-prefix {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 13px;
		color: #4a4842;
	}

	.manual-input {
		flex: 1;
		background: transparent;
		border: 0;
		outline: 0;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 16px;
		color: #f0ede4;
	}

	.manual-input::placeholder {
		color: #4a4842;
	}

	.error {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 13px;
		font-style: italic;
		color: #c98a8a;
		margin: 0;
		padding-left: 10px;
		border-left: 2px solid #6f3a3a;
	}

	.manual-actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 18px;
	}

	.primary {
		display: inline-flex;
		align-items: center;
		gap: 14px;
		padding: 10px 20px;
		border: 1px solid #46443d;
		border-radius: 2px;
		background: transparent;
		color: #f0ede4;
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 15px;
		font-weight: 500;
		cursor: pointer;
		transition:
			border-color 320ms cubic-bezier(0.16, 1, 0.3, 1),
			color 320ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.primary:hover:not(:disabled) {
		border-color: #d4cab2;
		color: #f7f4ec;
	}

	.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (prefers-reduced-motion: reduce) {
		.row {
			animation: none;
		}
	}
</style>
