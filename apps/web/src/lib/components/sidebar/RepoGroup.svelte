<script lang="ts">
	import type { PullRequest, Repository } from '@revv/shared';
	import { untrack } from 'svelte';
	import { getSelectedPrId } from '$lib/stores/prs.svelte';
	import { getCollapseAllSignal } from '$lib/stores/sidebar.svelte';
	import { getFocusedId } from '$lib/stores/sidebar-nav.svelte';
	import PrItem from './PrItem.svelte';

	let {
		repository,
		prs,
		navPrefix = 'pr',
	}: {
		repository: Repository;
		prs: PullRequest[];
		navPrefix?: string;
	} = $props();

	let expanded = $state(false);
	let lastSignal = $state(0);
	let avatarFailed = $state(false);

	// Reset failure state if the avatar URL changes
	$effect(() => {
		repository.avatarUrl;
		avatarFailed = false;
	});

	const selectedPrId = $derived(getSelectedPrId());
	const navId = $derived(`${navPrefix}:repo:${repository.id}`);
	const isFocused = $derived(getFocusedId() === navId);

	// Collapse when the global collapse-all signal fires
	$effect(() => {
		const current = getCollapseAllSignal();
		if (current > 0 && current !== untrack(() => lastSignal)) {
			expanded = false;
			lastSignal = current;
		}
	});

	function toggle() {
		expanded = !expanded;
	}
</script>

<div class="select-none">
	<button
		class="flex w-full items-center gap-1.5 px-3 py-1.5 transition-colors hover:bg-bg-tertiary {isFocused
			? 'sidebar-nav-focused'
			: ''}"
		onclick={toggle}
		aria-label="Toggle {repository.fullName}"
		aria-expanded={expanded}
		data-sidebar-nav={navId}
		data-nav-type="repo"
		data-nav-expanded={expanded}
	>
		<svg
			class="h-3 w-3 shrink-0 text-text-muted transition-transform duration-150 {expanded ? 'rotate-90' : ''}"
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
		>
			<path d="m9 18 6-6-6-6" />
		</svg>

		{#if repository.avatarUrl && !avatarFailed}
			<img
				src={repository.avatarUrl}
				alt=""
				class="h-3.5 w-3.5 shrink-0 rounded-sm object-cover"
				loading="lazy"
				onerror={() => (avatarFailed = true)}
			/>
		{:else}
			<svg
				class="h-3.5 w-3.5 shrink-0 text-text-muted"
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 16 16"
				fill="currentColor"
				aria-hidden="true"
			>
				<path
					d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"
				/>
			</svg>
		{/if}

		<span class="min-w-0 flex-1 truncate text-left text-xs font-medium text-text-secondary">
			{repository.fullName}
		</span>

		<span
			class="shrink-0 rounded-full bg-bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-muted"
		>
			{prs.length}
		</span>
	</button>

	{#if expanded}
		<div class="ml-2 flex flex-col gap-0.5 border-l border-border-subtle pl-2">
			{#each prs as pr (pr.id)}
				<PrItem {pr} isSelected={selectedPrId === pr.id} {navPrefix} />
			{/each}
		</div>
	{/if}
</div>

<style>
	:global(.sidebar-nav-focused) {
		background: var(--color-bg-tertiary) !important;
		box-shadow: inset 2px 0 0 var(--color-accent);
	}
</style>
