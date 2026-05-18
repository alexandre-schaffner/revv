<script lang="ts">
import type { Repository } from "@revv/shared";
import { goto } from "$app/navigation";
import RepoGradientAvatar from "$lib/components/shared/RepoGradientAvatar.svelte";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import { setSidebarPeekHovering, setSidebarPeekRepoId } from "$lib/stores/sidebar.svelte";

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
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		<button
			type="button"
			class="repo-button"
			class:repo-button--active={isActive}
			onclick={handleClick}
			onmouseenter={() => {
				setSidebarPeekRepoId(repository.id);
				setSidebarPeekHovering(true);
			}}
			onmouseleave={() => setSidebarPeekHovering(false)}
			aria-label={repository.fullName}
			aria-current={isActive ? 'page' : undefined}
		>
			<span class="avatar-wrap">
				<RepoGradientAvatar
					fullName={repository.fullName}
					size={30}
					radius={7}
					class="avatar"
				/>
				{#if showCloneIndicator}
					<span
						class="status-dot"
						class:status-dot--pending={repository.cloneStatus !== 'error'}
						class:status-dot--error={repository.cloneStatus === 'error'}
						aria-hidden="true"
					></span>
				{/if}
			</span>
		</button>
	</Tooltip.Trigger>
	<Tooltip.Content side="right" sideOffset={8}>
		{repository.fullName}
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
		border-radius: 9px;
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

	.avatar {
		flex-shrink: 0;
	}

	.repo-button--active .avatar {
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

	.status-dot--pending {
		background: var(--color-warning, #f59e0b);
	}

	.status-dot--error {
		background: var(--color-danger, #ef4444);
	}
</style>
