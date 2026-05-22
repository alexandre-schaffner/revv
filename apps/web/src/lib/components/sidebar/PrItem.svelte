<script lang="ts">
import type { PullRequest } from "@revv/shared";
import Pin from "phosphor-svelte/lib/PushPin";
import User from "phosphor-svelte/lib/User";
import { isPrPinned, pinPr, selectPr, unpinPr } from "$lib/stores/prs.svelte";
import { setSidebarView } from "$lib/stores/sidebar.svelte";
import { getFocusedId } from "$lib/stores/sidebar-nav.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";

interface Props {
  pr: PullRequest;
  isSelected?: boolean;
  navPrefix?: string;
  variant?: "open" | "archived";
}

let { pr, isSelected = false, navPrefix = "pr", variant = "open" }: Props = $props();

let avatarFailed = $state(false);

$effect(() => {
  pr.authorAvatarContent;
  avatarFailed = false;
});

const navId = $derived(`${navPrefix}:${pr.id}`);
const isFocused = $derived(getFocusedId() === navId);

function handleClick() {
  if (!isSelected) {
    selectPr(pr.id);
  }
  setSidebarView("files");
}
</script>

<div class="select-none">
	<button
		class="group flex w-full cursor-pointer items-start gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-bg-tertiary {isSelected
			? 'bg-bg-elevated'
			: ''} {isFocused ? 'sidebar-nav-focused' : ''} {variant === 'archived' ? 'opacity-70' : ''}"
			onclick={handleClick}
		aria-label="PR #{pr.externalId}: {pr.title}"
		data-sidebar-nav={navId}
		data-nav-type="pr"
		data-nav-parent="repo:{pr.repositoryId}"
	>
	{#if pr.authorAvatarContent && !avatarFailed}
		<img
			src={pr.authorAvatarContent}
				alt={pr.authorLogin}
				class="mt-0.5 h-4 w-4 shrink-0 rounded-full object-cover"
				loading="lazy"
				referrerpolicy="no-referrer"
				onerror={() => (avatarFailed = true)}
			/>
		{:else}
			<span
				class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-text-muted"
				title={pr.authorLogin}
			>
				<User size={10} weight="regular" aria-hidden="true" />
			</span>
		{/if}

		<div class="flex min-w-0 flex-1 flex-col gap-0.5">
			<span
				class="min-w-0 truncate text-xs leading-tight {variant === 'archived'
					? 'text-text-secondary'
					: 'text-text-primary'}"
			>
				{pr.title}
			</span>
			<div class="flex min-w-0 items-center gap-1 truncate text-[11px] leading-tight text-text-muted">
				<span>#{pr.externalId}</span>
				<span>·</span>
				<span>by {pr.authorLogin}</span>
				<span>·</span>
				<span>{formatRelativeTime(pr.updatedAt)}</span>
			</div>
		</div>

		{#if variant !== 'archived'}
			{@const pinned = isPrPinned(pr.id)}
			<button
				type="button"
				class="mt-0.5 shrink-0 opacity-0 transition-opacity duration-quick group-hover:opacity-100 {pinned
					? 'opacity-100 text-accent'
					: 'text-text-muted hover:text-text-secondary'}"
				onclick={(e) => {
					e.stopPropagation();
					if (pinned) unpinPr(pr.id);
					else pinPr(pr.id);
				}}
				aria-label={pinned ? 'Unpin PR' : 'Pin PR'}
				title={pinned ? 'Unpin' : 'Pin'}
			>
				<Pin size={11} aria-hidden="true" class={pinned ? 'fill-current' : ''} />
			</button>
		{/if}
	</button>
</div>

<style>
</style>
