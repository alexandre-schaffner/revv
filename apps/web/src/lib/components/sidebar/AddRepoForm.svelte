<script lang="ts">
	import type { Repository } from '@revv/shared';
	import { RefreshCw, Loader2 } from '@lucide/svelte';
	import {
		addRepo,
		getRepositories,
		getAvailableRepos,
		getAvailableReposLoading,
		fetchAvailableRepos,
		retryClone,
		deleteRepo,
	} from '$lib/stores/prs.svelte';
	import CloneStatusIndicator from '$lib/components/shared/CloneStatusIndicator.svelte';
	import { toast } from 'svelte-sonner';

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

	let activeTab = $state<'browse' | 'manual'>('browse');

	// -- Browse tab state --
	let browseSearch = $state('');
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
		browseSearch.trim() === ''
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
	let fullName = $state('');
	let isLoading = $state(false);
	let localError = $state('');

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
			toast.error(e instanceof Error ? e.message : 'Failed to add repository');
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
		if (!trimmed || !trimmed.includes('/')) {
			localError = 'Enter a valid repo in owner/name format';
			return;
		}
		isLoading = true;
		localError = '';
		try {
			await addRepo(trimmed);
			fullName = '';
			onClose?.();
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
			onClose?.();
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
		if (e.key === 'Escape') onClose?.();
		if (e.key === 'Tab' && e.shiftKey) {
			e.preventDefault();
			activeTab = 'browse';
		}
	}
</script>

{#if showTitle}
	<h2 class="mb-3 flex-shrink-0 text-sm font-semibold text-text-primary">Add Repository</h2>
{/if}

<!-- Tabs -->
<div class="flex flex-shrink-0 gap-0 border-b border-border">
	<button
		class="relative cursor-pointer px-3 pb-2 text-xs font-medium transition-colors {activeTab === 'browse'
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
		class="relative cursor-pointer px-3 pb-2 text-xs font-medium transition-colors {activeTab === 'manual'
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

<!-- Tab content -->
{#if activeTab === 'browse'}
	<div class="flex min-h-0 flex-1 flex-col">
		<!-- Search + refresh -->
		<div class="flex items-center gap-2 pt-3 pb-2">
			<input
				class="h-8 flex-1 rounded-md border border-border bg-bg-elevated px-3 text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
				placeholder="Search repositories..."
				bind:value={browseSearch}
				onkeydown={handleBrowseKeydown}
				use:focusOnMount
			/>
			<button
				class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
				onclick={() => fetchAvailableRepos(true)}
				disabled={getAvailableReposLoading()}
				title="Refresh"
			>
				<RefreshCw size={13} class={getAvailableReposLoading() ? 'animate-spin' : ''} />
			</button>
		</div>

		<!-- Repo list. Negative margin lets items sit slightly closer to
			the parent's padded edge, matching the original dialog's `px-2`
			list inside an unpadded dialog. -->
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
							<span
								class="text-[10px] font-semibold uppercase tracking-wider text-text-muted"
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
								class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors
									{isHighlighted
									? 'bg-bg-elevated ring-1 ring-inset ring-accent/40'
									: !isTracked
										? 'hover:bg-bg-elevated'
										: ''}
									{!isTracked && !isAdding ? 'cursor-pointer' : ''}"
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
											class="cursor-pointer text-xs text-text-muted transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
											onclick={(e) => {
												e.stopPropagation();
												handleBrowseRemove(trackedRepo.id);
											}}
											disabled={isRemoving}
											aria-label="Remove {repo.fullName}"
										>
											{isRemoving ? 'Removing…' : 'Remove'}
										</button>
									{:else if !isAdding}
										<span
											class="rounded bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"
											>Add</span
										>
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
		<!-- Browse footer. Negative horizontal margin lets the top border
			span the full parent width, then `px-5` puts the button back at
			the original 5-unit indent. -->
		<div
			class="-mx-5 mt-2 flex flex-shrink-0 justify-end border-t border-border px-5 pt-3"
		>
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
