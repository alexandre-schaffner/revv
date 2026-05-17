<script lang="ts">
import type { Repository } from "@revv/shared";
import { untrack } from "svelte";
import { slide } from "svelte/transition";
import CloneStatusIndicator from "$lib/components/shared/CloneStatusIndicator.svelte";
import { getArchivedByRepo, getGroupedByRepo, retryClone } from "$lib/stores/prs.svelte";
import { getCollapseAllSignal } from "$lib/stores/sidebar.svelte";
import { getFocusedId } from "$lib/stores/sidebar-nav.svelte";
import RepoArchiveSubsection from "./RepoArchiveSubsection.svelte";
import RepoPrsSubsection from "./RepoPrsSubsection.svelte";
import RepoRecapsSubsection from "./RepoRecapsSubsection.svelte";

interface Props {
  repository: Repository;
}

let { repository }: Props = $props();

let expanded = $state(false);
let lastSignal = $state(0);
let avatarFailed = $state(false);

$effect(() => {
  repository.avatarUrl;
  avatarFailed = false;
});

// Collapse when the global collapse-all signal fires
$effect(() => {
  const current = getCollapseAllSignal();
  if (current > 0 && current !== untrack(() => lastSignal)) {
    expanded = false;
    lastSignal = current;
  }
});

function toggle(): void {
  expanded = !expanded;
}

const openCount = $derived((getGroupedByRepo().get(repository.id) ?? []).length);
const archiveCount = $derived((getArchivedByRepo().get(repository.id) ?? []).length);
const totalCount = $derived(openCount + archiveCount);
const navId = $derived(`repo:${repository.id}`);
const isFocused = $derived(getFocusedId() === navId);
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
			class="h-3 w-3 shrink-0 text-text-muted transition-transform duration-snap ease-out-expo {expanded ? 'rotate-90' : ''}"
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
				referrerpolicy="no-referrer"
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
			{repository.name}
		</span>

		<CloneStatusIndicator
			status={repository.cloneStatus}
			error={repository.cloneError}
			onRetry={() => retryClone(repository.id)}
			size={12}
		/>

		{#if totalCount > 0}
			<span
				class="shrink-0 rounded-full bg-bg-elevated px-1.5 py-0.5 text-xs font-medium text-text-muted"
			>
				{totalCount}
			</span>
		{/if}
	</button>

	{#if expanded}
		<div class="subsections" transition:slide={{ duration: 220 }}>
			<RepoRecapsSubsection repoId={repository.id} navParent={navId} />
			<RepoPrsSubsection repoId={repository.id} navParent={navId} />
			{#if archiveCount > 0}
				<RepoArchiveSubsection repoId={repository.id} navParent={navId} />
			{/if}
		</div>
	{/if}
</div>

<style>
	.subsections {
		display: flex;
		flex-direction: column;
		gap: 0;
		padding-top: 2px;
		padding-bottom: 4px;
	}
	:global(.sidebar-nav-focused) {
		background: var(--color-bg-tertiary) !important;
		box-shadow: inset 2px 0 0 var(--color-accent);
	}
</style>
