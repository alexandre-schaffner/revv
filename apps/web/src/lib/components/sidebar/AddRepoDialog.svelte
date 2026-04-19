<script lang="ts">
	import { Lock, RefreshCw, Check, Loader2 } from '@lucide/svelte';
	import {
		addRepo,
		getRepositories,
		getAvailableRepos,
		getAvailableReposLoading,
		fetchAvailableRepos,
	} from '$lib/stores/prs.svelte';
	import { toast } from 'svelte-sonner';

	let { open = false, onClose }: { open?: boolean; onClose: () => void } = $props();

	// Focus an input on mount. Preferred over the `autofocus` attribute,
	// which Svelte's a11y lints flag because it can disorient screen
	// reader users when focus moves without a user-initiated action.
	// Here the input only mounts when the user opens the dialog or
	// switches tabs, which is an explicit user action — so focusing
	// the first field is the expected behaviour.
	function focusOnMount(node: HTMLElement) {
		node.focus();
	}

	let activeTab = $state<'browse' | 'manual'>('browse');

	// -- Browse tab state --
	let browseSearch = $state('');
	let addingRepos = $state(new Set<string>());
	let highlightedIndex = $state(-1);
	let repoListEl = $state<HTMLDivElement | null>(null);

	let trackedFullNames = $derived(new Set(getRepositories().map((r) => r.fullName)));

	let filteredAvailable = $derived(
		browseSearch.trim() === ''
			? getAvailableRepos()
			: getAvailableRepos().filter(
					(repo) =>
						repo.fullName.toLowerCase().includes(browseSearch.toLowerCase()) ||
						repo.owner.toLowerCase().includes(browseSearch.toLowerCase()) ||
						repo.name.toLowerCase().includes(browseSearch.toLowerCase())
				)
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

	// Reset highlight when search changes
	$effect(() => {
		browseSearch;
		highlightedIndex = -1;
	});

	// -- Manual tab state --
	let fullName = $state('');
	let isLoading = $state(false);
	let localError = $state('');

	// Fetch repos when dialog opens
	$effect(() => {
		if (open && getAvailableRepos().length === 0) {
			fetchAvailableRepos();
		}
	});

	// Reset state when dialog closes
	$effect(() => {
		if (!open) {
			browseSearch = '';
			fullName = '';
			localError = '';
			activeTab = 'browse';
			highlightedIndex = -1;
		}
	});

	async function handleBrowseAdd(repoFullName: string) {
		if (addingRepos.has(repoFullName) || trackedFullNames.has(repoFullName)) return;
		addingRepos = new Set([...addingRepos, repoFullName]);
		try {
			await addRepo(repoFullName);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to add repository');
		} finally {
			const next = new Set(addingRepos);
			next.delete(repoFullName);
			addingRepos = next;
		}
	}

	async function handleManualAdd() {
		const trimmed = fullName.trim();
		if (!trimmed || !trimmed.includes('/')) {
			localError = 'Enter a valid repo in owner/name format';
			return;
		}
		isLoading = true;
		localError = '';
		try {
			await addRepo(trimmed);
			fullName = '';
			onClose();
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to add repository';
			localError = msg;
			toast.error(msg);
		} finally {
			isLoading = false;
		}
	}

	function scrollHighlightedIntoView() {
		if (!repoListEl) return;
		const el = repoListEl.querySelector<HTMLElement>('[data-highlighted="true"]');
		el?.scrollIntoView({ block: 'nearest' });
	}

	function handleBrowseKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onClose();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlightedIndex = Math.min(highlightedIndex + 1, filteredAvailable.length - 1);
			scrollHighlightedIntoView();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (highlightedIndex > 0) highlightedIndex--;
			scrollHighlightedIntoView();
		} else if (e.key === 'Enter' && highlightedIndex >= 0) {
			const repo = filteredAvailable[highlightedIndex];
			if (repo) handleBrowseAdd(repo.fullName);
		} else if (e.key === 'Tab' && e.shiftKey) {
			e.preventDefault();
			activeTab = activeTab === 'browse' ? 'manual' : 'browse';
		}
	}

	function handleManualKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') handleManualAdd();
		if (e.key === 'Escape') onClose();
		if (e.key === 'Tab' && e.shiftKey) {
			e.preventDefault();
			activeTab = 'browse';
		}
	}
</script>

{#if open}
	<!-- Backdrop -->
	<div class="fixed inset-0 z-40 bg-black/60" role="presentation" onclick={onClose}></div>

	<!-- Dialog -->
	<div
		class="fixed left-1/2 top-1/2 z-50 flex w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-bg-secondary shadow-2xl"
		style="max-height: min(560px, 80vh)"
		role="dialog"
		aria-modal="true"
		aria-label="Add repository"
	>
		<!-- Header -->
		<div class="flex-shrink-0 px-5 pt-5 pb-0">
			<h2 class="mb-3 text-sm font-semibold text-text-primary">Add Repository</h2>

			<!-- Tabs -->
			<div class="flex gap-0 border-b border-border">
				<button
					class="relative px-3 pb-2 text-xs font-medium transition-colors {activeTab === 'browse'
						? 'text-text-primary'
						: 'text-text-muted hover:text-text-secondary'}"
					onclick={() => (activeTab = 'browse')}
				>
					Browse
					{#if activeTab === 'browse'}
						<div class="absolute bottom-0 left-0 right-0 h-[2px] bg-accent"></div>
					{/if}
				</button>
				<button
					class="relative px-3 pb-2 text-xs font-medium transition-colors {activeTab === 'manual'
						? 'text-text-primary'
						: 'text-text-muted hover:text-text-secondary'}"
					onclick={() => (activeTab = 'manual')}
				>
					Manual
					{#if activeTab === 'manual'}
						<div class="absolute bottom-0 left-0 right-0 h-[2px] bg-accent"></div>
					{/if}
				</button>
			</div>
		</div>

		<!-- Tab content -->
		{#if activeTab === 'browse'}
			<!-- Browse tab -->
			<div class="flex min-h-0 flex-1 flex-col">
				<!-- Search + refresh -->
				<div class="flex items-center gap-2 px-5 pt-3 pb-2">
					<input
						class="h-8 flex-1 rounded-md border border-border bg-bg-elevated px-3 text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
						placeholder="Search repositories..."
						bind:value={browseSearch}
						onkeydown={handleBrowseKeydown}
						use:focusOnMount
					/>
					<button
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
						onclick={() => fetchAvailableRepos(true)}
						disabled={getAvailableReposLoading()}
						title="Refresh"
					>
						<RefreshCw
							size={13}
							class={getAvailableReposLoading() ? 'animate-spin' : ''}
						/>
					</button>
				</div>

				<!-- Repo list -->
				<div class="flex-1 overflow-y-auto px-2 pb-3" bind:this={repoListEl}>
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
								<div
									class="sticky top-0 z-10 flex items-center gap-2 bg-bg-secondary px-3 py-1.5"
								>
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
									<span class="text-[10px] font-semibold uppercase tracking-wider text-text-muted"
										>{owner}</span
									>
								</div>

								<!-- Repos in this group -->
								{#each repos as repo (repo.fullName)}
									{@const isTracked = trackedFullNames.has(repo.fullName)}
									{@const isAdding = addingRepos.has(repo.fullName)}
									{@const flatIndex = filteredAvailable.indexOf(repo)}
									{@const isHighlighted = flatIndex === highlightedIndex}
									<button
										class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors
											{isTracked
											? 'opacity-50'
											: isHighlighted
												? 'bg-bg-elevated ring-1 ring-inset ring-accent/40'
												: 'hover:bg-bg-elevated'}"
										data-highlighted={isHighlighted ? 'true' : undefined}
										onclick={() => handleBrowseAdd(repo.fullName)}
										disabled={isTracked || isAdding}
									>
										<div class="min-w-0 flex-1">
											<div class="flex items-center gap-1.5">
												<span class="truncate text-xs font-medium text-text-primary"
													>{repo.name}</span
												>
												{#if repo.provider === 'github' && repo.avatarUrl}
													<!-- private repos don't have a direct flag in Repository type, but we show the lock contextually -->
												{/if}
											</div>
										</div>
										<div class="flex-shrink-0">
											{#if isTracked}
												<Check size={14} class="text-green-500" />
											{:else if isAdding}
												<Loader2 size={14} class="animate-spin text-text-muted" />
											{:else}
												<span
													class="rounded bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"
													>Add</span
												>
											{/if}
										</div>
									</button>
								{/each}
							</div>
						{/each}
					{/if}
				</div>
			</div>

			<!-- Browse footer -->
			<div class="flex flex-shrink-0 justify-end border-t border-border px-5 py-3">
				<button
					class="rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text-secondary"
					onclick={onClose}
				>
					Done
				</button>
			</div>
		{:else}
			<!-- Manual tab -->
			<div class="p-5">
				<p class="mb-3 text-xs text-text-muted">
					Enter the repository in owner/name format
				</p>

				<input
					class="h-9 w-full rounded-md border border-border bg-bg-elevated px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
					placeholder="owner/repository"
					bind:value={fullName}
					onkeydown={handleManualKeydown}
					disabled={isLoading}
					use:focusOnMount
				/>

				{#if localError}
					<p class="mt-1.5 text-xs text-danger">{localError}</p>
				{/if}

				<div class="mt-4 flex justify-end gap-2">
					<button
						class="rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text-secondary"
						onclick={onClose}
						disabled={isLoading}
					>
						Cancel
					</button>
					<button
						class="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
						onclick={handleManualAdd}
						disabled={isLoading || !fullName.trim()}
					>
						{isLoading ? 'Adding...' : 'Add'}
					</button>
				</div>
			</div>
		{/if}
	</div>
{/if}
