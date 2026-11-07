<script lang="ts">
import type { Repository } from "@revv/shared";
import House from "phosphor-svelte/lib/House";
import Plus from "phosphor-svelte/lib/Plus";
import User from "phosphor-svelte/lib/User";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import Avatar from "$lib/components/shared/Avatar.svelte";
import RepoAvatarButton from "$lib/components/sidebar/RepoAvatarButton.svelte";
import * as Collapsible from "$lib/components/ui/collapsible";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import { bitsAnim, collapsibleClose, collapsibleOpen } from "$lib/motion";
import { groupByOwner } from "$lib/repos/add-repo";
import { getRepositories } from "$lib/stores/repos.svelte";
import { getSelectedRepoId } from "$lib/stores/route.svelte";
import {
  isOwnerCollapsed,
  setAddRepoDialogOpen,
  toggleOwnerCollapsed,
} from "$lib/stores/sidebar.svelte";

type OwnerGroup = {
  owner: string;
  avatarUrl: string | null;
  repos: Repository[];
};

const repos = $derived(getRepositories());
const activeRepoId = $derived(getSelectedRepoId());
const isHome = $derived(page.url.pathname === "/");

async function handleHome(): Promise<void> {
  if (page.url.pathname === "/") return;
  await goto("/");
}

// Server order is kept, so grouping doesn't reshuffle the rail on every
// render. `avatarUrl` is the owner's avatar from the group's first repo that
// has one.
const ownerGroups = $derived(
  [...groupByOwner(repos)].map(
    ([owner, grouped]): OwnerGroup => ({
      owner,
      avatarUrl: grouped.find((repo) => repo.avatarUrl !== null)?.avatarUrl ?? null,
      repos: grouped,
    }),
  ),
);

function handleAddRepo(): void {
  setAddRepoDialogOpen(true);
}
</script>

<aside class="rail" aria-label="Projects">
	<div class="rail-home">
		<Tooltip.Root>
			<Tooltip.Trigger>
				<button
					type="button"
					class="rail-action home-button"
					class:home-button--active={isHome}
					onclick={handleHome}
					aria-label="Home"
					aria-current={isHome ? 'page' : undefined}
				>
					<House size={18} weight={isHome ? 'fill' : 'regular'} />
				</button>
			</Tooltip.Trigger>
			<Tooltip.Content side="right" sideOffset={8}>Home</Tooltip.Content>
		</Tooltip.Root>
		<div class="rail-divider" aria-hidden="true"></div>
	</div>

	<div class="rail-top">
		{#each ownerGroups as group (group.owner)}
			{@const collapsed = isOwnerCollapsed(group.owner)}
			{@const hasActiveChild = group.repos.some((r) => r.id === activeRepoId)}
			{@const isMulti = group.repos.length > 1}
			<!-- `open` comes from a persisted store so the collapsed state
			     survives reloads. -->
			<Collapsible.Root
				open={!collapsed}
				onOpenChange={() => toggleOwnerCollapsed(group.owner)}
			>
				<div
					class="folder-pill"
					class:folder-pill--active={collapsed && hasActiveChild}
					class:folder-pill--grouped={!collapsed}
					role="group"
					aria-label={group.owner}
				>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props: tooltipProps })}
								<Collapsible.Trigger
									{...tooltipProps}
									class="folder-pill-trigger"
									aria-label={collapsed
										? `Expand ${group.owner} (${group.repos.length} repositories)`
										: `Collapse ${group.owner} (${group.repos.length} repositories)`}
								>
									{#if collapsed}
										<span class="folder-pill-header">
											<Avatar src={group.avatarUrl} size={28} radius="8px">
												{#snippet fallback()}
													<span class="folder-pill-avatar folder-pill-avatar--fallback" aria-hidden="true">
														<User size={14} />
													</span>
												{/snippet}
											</Avatar>
											{#if isMulti}
												<span class="folder-pill-count" aria-hidden="true">
													{group.repos.length}
												</span>
											{/if}
										</span>
									{:else}
										<Avatar src={group.avatarUrl} size={28} radius="8px">
											{#snippet fallback()}
												<span class="folder-pill-fallback" aria-hidden="true">
													<User size={14} />
												</span>
											{/snippet}
										</Avatar>
									{/if}
								</Collapsible.Trigger>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="right" sideOffset={8}>
							{group.owner} · {group.repos.length} {group.repos.length === 1 ? 'repo' : 'repos'}
						</Tooltip.Content>
					</Tooltip.Root>

					<Collapsible.Content>
						{#snippet child({ props })}
							<div
								{...props}
								class="folder-pill-content"
								use:bitsAnim={{
									inPreset: collapsibleOpen,
									outPreset: collapsibleClose,
									settleOnMount: true,
								}}
							>
								<div class="folder-pill-content-inner">
									{#each group.repos as repo (repo.id)}
										<RepoAvatarButton repository={repo} isActive={repo.id === activeRepoId} />
									{/each}
								</div>
							</div>
						{/snippet}
					</Collapsible.Content>
				</div>
			</Collapsible.Root>
		{/each}

		<Tooltip.Root>
			<Tooltip.Trigger>
				<button
					type="button"
					class="rail-action rail-action--add"
					onclick={handleAddRepo}
					aria-label="Add repository"
				>
					<Plus size={18} />
				</button>
			</Tooltip.Trigger>
			<Tooltip.Content side="right" sideOffset={8}>Add repository</Tooltip.Content>
		</Tooltip.Root>
	</div>

	<div class="rail-fade" aria-hidden="true"></div>
</aside>

<style>
	.rail {
		position: relative; /* anchor for .rail-fade */
		display: flex;
		flex-direction: column;
		height: 100%;
		width: 100%;
		padding: var(--spacing-island) 0 0;
		background: var(--color-bg-secondary);
		overflow: hidden;
	}

	.rail-fade {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 48px;
		background: linear-gradient(to bottom, transparent 0%, color-mix(in srgb, var(--color-bg-secondary) 90%, transparent) 80%, var(--color-bg-secondary) 100%);
		pointer-events: none;
		z-index: 5;
	}

	/* Bottom padding equals .rail-fade height so the last avatar can scroll
	   past the fade region instead of sitting half-covered behind it. */
	.rail-top {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 0 var(--spacing-inset) 48px;
		scrollbar-width: thin;
		scrollbar-color: var(--color-border) transparent;
	}

	.rail-top::-webkit-scrollbar {
		width: 4px;
	}
	.rail-top::-webkit-scrollbar-thumb {
		background: var(--color-border);
		border-radius: 2px;
	}

	/* Transparent by default so a single avatar floats on the rail. Radii
	   are concentric: avatar 8 → trigger 10 → grouped panel 12. */
	.folder-pill {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 40px;
		padding: 0;
		background: transparent;
		border-radius: 12px;
		transition: background-color var(--duration-quick) var(--ease-out-expo),
			box-shadow var(--duration-quick) var(--ease-out-expo);
	}

	.folder-pill--grouped {
		background: var(--color-bg-tertiary);
		box-shadow: inset 0 0 0 1px var(--color-border-subtle);
	}

	/* Hidden when expanded: each child's own indicator takes over. */
	.folder-pill--active::before {
		content: '';
		position: absolute;
		left: -9px;
		top: 8px;
		bottom: 8px;
		width: 3px;
		border-radius: 0 2px 2px 0;
		background: var(--color-accent, var(--color-text-primary));
	}

	:global(.folder-pill-trigger) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: none;
		border-radius: 10px;
		background: transparent;
		color: var(--color-accent);
		cursor: pointer;
		transition: background-color var(--duration-snap);
	}

	:global(.folder-pill-trigger:hover) {
		background: var(--color-bg-elevated);
	}

	:global(.folder-pill-trigger:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}

	.folder-pill-header {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 8px;
		background: var(--color-bg-secondary);
	}

	.folder-pill-avatar {
		width: 28px;
		height: 28px;
		border-radius: 8px;
	}

	.folder-pill-fallback {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-secondary);
		text-transform: uppercase;
	}

	.folder-pill-avatar--fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		background: var(--color-bg-secondary);
	}

	.folder-pill-count {
		position: absolute;
		right: -5px;
		bottom: -5px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: 8px;
		background: var(--color-bg-elevated);
		box-shadow: 0 0 0 2px var(--color-bg-secondary),
			inset 0 0 0 1px var(--color-border-subtle),
			0 1px 2px rgba(42, 40, 37, 0.06);
		color: var(--color-text-secondary);
		font-size: 9px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}

	/* --primary-foreground is the on-accent ink: white on light's deep teal,
	   near-black on dark's luminous one. A fixed white would read 2.4:1 in
	   dark. */
	.folder-pill--active .folder-pill-count {
		background: var(--color-accent);
		color: var(--color-primary-foreground);
		box-shadow: 0 0 0 2px var(--color-bg-secondary),
			inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 70%, #000),
			0 1px 2px rgba(15, 118, 110, 0.18);
	}

	.folder-pill-content {
		overflow: hidden;
		width: 100%;
	}

	/* Vertical padding sits on the inner content (not the pill) so the
	   pill is exactly 40 × 40 when collapsed — matching a standalone
	   repo tile — and only grows by the breathing room when expanded. */
	.folder-pill-content-inner {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: var(--spacing-island-half) 0;
	}

	/* The default ring's bg-secondary gap reads as an off-center dark frame
	   on the pill's bg-tertiary, so inside the pill it's one solid accent
	   ring flush against the avatar. */
	:global(.folder-pill-content .repo-button--active .avatar) {
		box-shadow: 0 0 0 2px var(--color-accent, var(--color-text-primary));
	}

	.rail-home {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		padding: 0 var(--spacing-inset) 6px;
	}

	.home-button {
		position: relative;
	}

	.home-button--active {
		background: var(--color-bg-elevated);
		color: var(--color-text-primary);
	}

	.home-button--active::before {
		content: '';
		position: absolute;
		left: -8px;
		top: 8px;
		bottom: 8px;
		width: 3px;
		border-radius: 0 2px 2px 0;
		background: var(--color-accent, var(--color-text-primary));
	}

	.rail-divider {
		width: 24px;
		height: 1px;
		flex-shrink: 0;
		background: var(--color-border-subtle);
	}

	.rail-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: none;
		border-radius: 10px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap),
			border-color var(--duration-snap);
	}

	.rail-action:hover {
		background: var(--color-bg-elevated);
		color: var(--color-text-primary);
	}

	.rail-action--add {
		margin-top: 4px;
		border: 1px dashed var(--color-border);
	}

	.rail-action--add:hover {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 6%, transparent);
		color: var(--color-accent);
	}
</style>
