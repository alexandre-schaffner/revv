<script lang="ts">
import type { Repository } from "@revv/shared";
import LinkSimple from "phosphor-svelte/lib/LinkSimple";
import { goto } from "$app/navigation";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";

interface Props {
  repository: Repository;
  isActive: boolean;
}

let { repository, isActive }: Props = $props();

async function handleClick(): Promise<void> {
  const target = `/repo/${repository.id}`;
  if (typeof window !== "undefined" && window.location.pathname === target) {
    return;
  }
  await goto(target);
}

const showCloneIndicator = $derived(
  repository.cloneStatus === "cloning" ||
    repository.cloneStatus === "pending" ||
    repository.cloneStatus === "error",
);

// Spell the clone state into the tooltip so the status dot never carries
// meaning by color alone (brand a11y contract).
const cloneStatusLabel = $derived.by(() => {
  switch (repository.cloneStatus) {
    case "cloning":
      return "Cloning…";
    case "pending":
      return "Queued to clone";
    case "error":
      return "Clone failed";
    default:
      return null;
  }
});
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		<button
			type="button"
			class="repo-button"
			class:repo-button--active={isActive}
			onclick={handleClick}
			aria-label={repository.fullName}
			aria-current={isActive ? 'page' : undefined}
		>
			<span class="avatar-wrap">
				<RepoGradientAvatar
					fullName={repository.fullName}
					ownerAvatarUrl={repository.avatarUrl}
					size={30}
					radius={8}
					class="avatar"
				/>
				{#if showCloneIndicator}
					<span
						class="status-dot"
						class:status-dot--cloning={repository.cloneStatus === 'cloning'}
						class:status-dot--pending={repository.cloneStatus === 'pending'}
						class:status-dot--error={repository.cloneStatus === 'error'}
						aria-hidden="true"
					></span>
				{:else if !repository.managed}
					<span class="linked-dot" aria-hidden="true">
						<LinkSimple size={8} weight="bold" />
					</span>
				{/if}
			</span>
		</button>
	</Tooltip.Trigger>
	<Tooltip.Content side="right" sideOffset={8}>
		{repository.fullName}{cloneStatusLabel ? ` · ${cloneStatusLabel}` : repository.managed ? '' : ' · Linked'}
	</Tooltip.Content>
</Tooltip.Root>

<style>
	.repo-button {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: none;
		border-radius: 10px;
		background: transparent;
		cursor: pointer;
		color: var(--color-text-muted);
		transition:
			background-color var(--duration-snap),
			transform var(--duration-snap) var(--ease-out-expo);
	}

	.repo-button:hover {
		background: var(--color-bg-elevated);
	}

	.repo-button:active {
		transform: scale(0.96);
	}

	.repo-button--active::before {
		content: '';
		position: absolute;
		left: -8px;
		top: 8px;
		bottom: 8px;
		width: 3px;
		border-radius: 0 2px 2px 0;
		background: var(--color-accent, var(--color-text-primary));
	}

	.avatar-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	:global(.avatar) {
		flex-shrink: 0;
	}

	:global(.repo-button--active .avatar) {
		box-shadow: 0 0 0 2px var(--color-bg-secondary), 0 0 0 3.5px var(--color-accent, var(--color-text-primary));
	}

	.status-dot {
		position: absolute;
		right: -2px;
		bottom: -2px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		border: 1.5px solid var(--color-bg-secondary);
	}

	/* Cloning is live work: the accent dot breathes a halo so it reads as
	   active, distinct from the static amber "queued" dot. */
	.status-dot--cloning {
		background: var(--color-accent, #2563eb);
	}

	.status-dot--cloning::after {
		content: '';
		position: absolute;
		z-index: -1;
		inset: -1.5px;
		border-radius: 50%;
		background: var(--color-accent, #2563eb);
		animation: clone-pulse 1.6s var(--ease-soft) infinite;
	}

	.status-dot--pending {
		background: var(--color-warning, #f59e0b);
	}

	.status-dot--error {
		background: var(--color-danger, #ef4444);
	}

	@keyframes clone-pulse {
		0% {
			opacity: 0.55;
			transform: scale(1);
		}
		70%,
		100% {
			opacity: 0;
			transform: scale(2.1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.status-dot--cloning::after {
			animation: none;
			opacity: 0;
		}
	}

	.linked-dot {
		position: absolute;
		right: -4px;
		bottom: -4px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border: 1.5px solid var(--color-bg-secondary);
		border-radius: 50%;
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}
</style>
