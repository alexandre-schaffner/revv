<script lang="ts">
import { GitMerge, GitPullRequestArrow, GitPullRequestClosed, User } from "@lucide/svelte";
import type { PullRequest } from "@revv/shared";
import StatusDot from "$lib/components/shared/StatusDot.svelte";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { isPrUnseen } from "$lib/stores/pr-visits.svelte";
import { selectPr } from "$lib/stores/prs.svelte";
import { setSidebarView } from "$lib/stores/sidebar.svelte";
import { getFocusedId } from "$lib/stores/sidebar-nav.svelte";

let {
  pr,
  isSelected = false,
  navPrefix = "pr",
  variant = "open",
  pinned = false,
}: {
  pr: PullRequest;
  isSelected?: boolean;
  navPrefix?: string;
  variant?: "open" | "archived";
  pinned?: boolean;
} = $props();

const showDot = $derived(isPrUnseen(pr, getCurrentUserLogin()));

let avatarFailed = $state(false);

$effect(() => {
  pr.authorAvatarUrl;
  avatarFailed = false;
});

const navId = $derived(`${navPrefix}:${pr.id}`);
const isFocused = $derived(getFocusedId() === navId);

// Selecting a PR always swipes the sidebar to the file-tree view. The
// tree itself is fetched by +layout.svelte's URL-watcher; here we just
// drive navigation + view state.
function handleClick() {
  if (!isSelected) {
    selectPr(pr.id);
  }
  setSidebarView("files");
}
</script>

<div class="select-none">
	<button
		class="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-bg-tertiary {isSelected
			? 'bg-bg-elevated'
			: ''} {isFocused ? 'sidebar-nav-focused' : ''} {variant === 'archived' ? 'opacity-70' : ''}"
		onclick={handleClick}
		aria-label="PR #{pr.externalId}: {pr.title}"
		data-sidebar-nav={navId}
		data-nav-type="pr"
		data-nav-parent="repo:{pr.repositoryId}"
	>
		{#if variant === 'archived'}
			{#if pr.status === 'merged'}
				<GitMerge size={11} class="shrink-0 text-[var(--color-accent-muted,#8b5cf6)]" aria-hidden="true" />
			{:else}
				<GitPullRequestClosed size={11} class="shrink-0 text-text-muted" aria-hidden="true" />
			{/if}
		{:else if pinned}
			<GitPullRequestArrow size={11} class="shrink-0 text-accent" aria-hidden="true" />
		{:else}
			<StatusDot status={pr.status} reviewStatus={pr.reviewStatus} visible={showDot} />
		{/if}
		<span class="min-w-0 flex-1 truncate text-xs leading-tight">
			<span class="text-text-muted">#{pr.externalId}</span>
			<span class="{variant === 'archived' ? 'text-text-secondary' : 'text-text-primary'}">{pr.title}</span>
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
</div>

<style>
</style>
