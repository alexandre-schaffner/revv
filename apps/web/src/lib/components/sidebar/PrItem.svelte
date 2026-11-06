<script lang="ts">
import type { PullRequest } from "@revv/shared";
import PushPin from "phosphor-svelte/lib/PushPin";
import Avatar from "$lib/components/shared/Avatar.svelte";
import { isPrPinned, pinPr, unpinPr } from "$lib/stores/prs.svelte";
import { getFocusedId, openPr, setFocusedId } from "$lib/stores/sidebar-nav.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";

interface Props {
  pr: PullRequest;
  isSelected?: boolean;
  variant?: "open" | "archived";
}

let { pr, isSelected = false, variant = "open" }: Props = $props();

const isFocused = $derived(getFocusedId() === pr.id);
let rowEl = $state<HTMLButtonElement | null>(null);

$effect(() => {
  if (isFocused) rowEl?.scrollIntoView({ block: "nearest" });
});

function handleClick() {
  setFocusedId(pr.id);
  openPr(pr.id);
}
</script>

<div class="select-none">
	<button
		class="group flex w-full cursor-pointer items-start gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-bg-tertiary {isSelected
			? 'bg-bg-elevated'
			: ''} {isFocused ? 'sidebar-nav-focused' : ''} {variant === 'archived' ? 'opacity-70' : ''}"
			onclick={handleClick}
		aria-label="PR #{pr.externalId}: {pr.title}"
		bind:this={rowEl}
	>
		<Avatar
			src={pr.authorAvatarContent}
			name={pr.authorLogin}
			size={16}
			fallback="user"
			glyphSize={10}
			class="mt-0.5"
		/>

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
			<span
				role="button"
				tabindex="0"
				class="pin-btn mt-0.5 shrink-0 opacity-0 transition-opacity duration-quick group-hover:opacity-100 {pinned
					? 'opacity-100 text-accent'
					: 'text-text-muted hover:text-text-secondary'}"
				onclick={(e) => {
					e.stopPropagation();
					if (pinned) unpinPr(pr.id);
					else pinPr(pr.id);
				}}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						e.stopPropagation();
						if (pinned) unpinPr(pr.id);
						else pinPr(pr.id);
					}
				}}
				aria-label={pinned ? 'Unpin PR' : 'Pin PR'}
				title={pinned ? 'Unpin' : 'Pin'}
			>
				<PushPin size={11} aria-hidden="true" class={pinned ? 'fill-current' : ''} />
			</span>
		{/if}
	</button>
</div>

<style>
</style>
