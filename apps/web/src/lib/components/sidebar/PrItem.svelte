<script lang="ts">
	import type { PullRequest } from '@revv/shared';
	import { selectPr } from '$lib/stores/prs.svelte';
	import { getFocusedId } from '$lib/stores/sidebar-nav.svelte';
	import {
		getReviewFiles,
		getIsLoadingFiles,
		getActiveFilePath,
		setActiveFilePath,
		getActiveTab,
		setActiveTab,
	} from '$lib/stores/review.svelte';
	import { enterScrollMode } from '$lib/stores/focus-mode.svelte';
	import { toFileTreeEntries } from '$lib/types/review';
	import { User } from '@lucide/svelte';
	import StatusDot from '$lib/components/shared/StatusDot.svelte';
	import DiffFileTree from '$lib/components/review/DiffFileTree.svelte';
	let { pr, isSelected = false, navPrefix = 'pr' }: { pr: PullRequest; isSelected?: boolean; navPrefix?: string } = $props();

	let expanded = $state(false);
	let avatarFailed = $state(false);

	$effect(() => {
		pr.authorAvatarUrl;
		avatarFailed = false;
	});

	const navId = $derived(`${navPrefix}:${pr.id}`);
	const isFocused = $derived(getFocusedId() === navId);
	const reviewFiles = $derived(getReviewFiles());
	const isLoadingFiles = $derived(getIsLoadingFiles());
	const activeFilePath = $derived(getActiveFilePath());
	const treeFiles = $derived(toFileTreeEntries(reviewFiles));

	// Auto-expand when this PR becomes selected; reset when deselected
	$effect(() => {
		if (isSelected) {
			expanded = true;
		} else {
			expanded = false;
		}
	});

	function handleClick() {
		if (isSelected) {
			expanded = !expanded;
		} else {
			selectPr(pr.id);
			expanded = true;
		}
	}

	function handleFileSelect(path: string) {
		setActiveFilePath(path);
		if (getActiveTab() !== 'diff') {
			setActiveTab('diff');
		}
		enterScrollMode();
	}
</script>

<div class="select-none">
	<button
		class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-bg-tertiary {isSelected
			? 'bg-bg-elevated'
			: ''} {isFocused ? 'sidebar-nav-focused' : ''}"
		onclick={handleClick}
		aria-label="PR #{pr.externalId}: {pr.title}"
		aria-expanded={expanded}
		data-sidebar-nav={navId}
		data-nav-type="pr"
		data-nav-expanded={expanded}
		data-nav-parent="repo:{pr.repositoryId}"
	>
		<StatusDot status={pr.status} reviewStatus={pr.reviewStatus} />
		<span class="min-w-0 flex-1 truncate text-xs leading-tight">
			<span class="text-text-muted">#{pr.externalId}</span>
			<span class="text-text-primary">{pr.title}</span>
		</span>
		{#if pr.authorAvatarUrl && !avatarFailed}
			<img
				src={pr.authorAvatarUrl}
				alt={pr.authorLogin}
				class="h-4 w-4 shrink-0 rounded-full object-cover"
				loading="lazy"
				referrerpolicy="no-referrer"
				onerror={() => (avatarFailed = true)}
			/>
		{:else}
			<span
				class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-text-muted"
				title={pr.authorLogin}
			>
				<User size={10} aria-hidden="true" />
			</span>
		{/if}
	</button>

	{#if isSelected && expanded}
		{#if isLoadingFiles}
			<div class="px-3 py-1.5 text-[11px] italic text-text-muted">Loading files…</div>
		{:else if treeFiles.length > 0}
			<div class="py-0.5">
				<DiffFileTree
					files={treeFiles}
					{activeFilePath}
					onFileSelect={handleFileSelect}
					showHeader={false}
					navParentId="pr:{pr.id}"
					prId={pr.id}
				/>
			</div>
		{/if}
	{/if}
</div>

<style>
</style>
