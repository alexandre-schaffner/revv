<script lang="ts">
	import type { PullRequest, Repository } from '@rev/shared';
	import { untrack } from 'svelte';
	import { getSelectedPrId } from '$lib/stores/prs.svelte';
	import { getCollapseAllSignal } from '$lib/stores/sidebar.svelte';
	import { getFocusedId } from '$lib/stores/sidebar-nav.svelte';
	import PrItem from './PrItem.svelte';

	let {
		repository,
		prs,
	}: {
		repository: Repository;
		prs: PullRequest[];
	} = $props();

	let expanded = $state(false);
	let lastSignal = $state(0);

	const selectedPrId = $derived(getSelectedPrId());
	const navId = $derived(`repo:${repository.id}`);
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

		{#if repository.avatarUrl}
			<img src={repository.avatarUrl} alt="" class="h-3.5 w-3.5 shrink-0 rounded-sm" />
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
				<PrItem {pr} isSelected={selectedPrId === pr.id} />
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
