<script lang="ts">
import type { Repository } from "@revv/shared";
import { Plus } from "@lucide/svelte";
import * as Collapsible from "$lib/components/ui/collapsible";
import RepoAvatarButton from "$lib/components/sidebar/RepoAvatarButton.svelte";
import UserMenu from "$lib/components/sidebar/UserMenu.svelte";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import { getRepositories, getSelectedRepoId } from "$lib/stores/prs.svelte";
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

// Group repos by owner (case-insensitive). First-seen owner / first-seen
// repo order preserves whatever the server returned so grouping doesn't
// reshuffle the rail on every render. `avatarUrl` is the GitHub owner
// avatar lifted from the first non-null repo in the group.
const ownerGroups = $derived.by((): OwnerGroup[] => {
  const groups = new Map<string, OwnerGroup>();
  for (const repo of repos) {
    const key = repo.owner.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.repos.push(repo);
      if (existing.avatarUrl === null && repo.avatarUrl !== null) {
        existing.avatarUrl = repo.avatarUrl;
      }
    } else {
      groups.set(key, { owner: repo.owner, avatarUrl: repo.avatarUrl, repos: [repo] });
    }
  }
  return [...groups.values()];
});

function handleAddRepo(): void {
  setAddRepoDialogOpen(true);
}
</script>

<aside class="rail" aria-label="Projects">
	<div class="rail-top">
		{#each ownerGroups as group (group.owner)}
			{@const collapsed = isOwnerCollapsed(group.owner)}
			{@const hasActiveChild = group.repos.some((r) => r.id === activeRepoId)}
			<!-- Collapsible drives ARIA (aria-expanded/controls), keyboard,
			     and the data-state attributes that power the open/close
			     height animation below. We control `open` via our own
			     persisted store so the collapsed state survives reloads. -->
			<Collapsible.Root
				open={!collapsed}
				onOpenChange={() => toggleOwnerCollapsed(group.owner)}
			>
				<div
					class="folder-pill"
					class:folder-pill--active={collapsed && hasActiveChild}
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
											{#if group.avatarUrl}
												<img
													src={group.avatarUrl}
													alt=""
													class="folder-pill-avatar"
													referrerpolicy="no-referrer"
												/>
											{:else}
												<span class="folder-pill-avatar folder-pill-avatar--fallback" aria-hidden="true">
													{group.owner.slice(0, 1).toUpperCase()}
												</span>
											{/if}
											<span class="folder-pill-count" aria-hidden="true">
												{group.repos.length}
											</span>
										</span>
									{:else}
										{#if group.avatarUrl}
											<img
												src={group.avatarUrl}
												alt=""
												class="folder-pill-avatar"
												referrerpolicy="no-referrer"
											/>
										{:else}
											<span class="folder-pill-fallback" aria-hidden="true">
												{group.owner.slice(0, 1).toUpperCase()}
											</span>
										{/if}
									{/if}
								</Collapsible.Trigger>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="right" sideOffset={8}>
							{group.owner} · {group.repos.length} repos
						</Tooltip.Content>
					</Tooltip.Root>

					<Collapsible.Content class="folder-pill-content">
						<div class="folder-pill-content-inner">
							{#each group.repos as repo (repo.id)}
								<RepoAvatarButton
									repository={repo}
									isActive={repo.id === activeRepoId}
								/>
							{/each}
						</div>
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

	<div class="rail-bottom">
		<div class="user-slot">
			<UserMenu collapsed />
		</div>
	</div>
</aside>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		height: 100%;
		width: 100%;
		padding: 10px 0 0;
		background: var(--color-bg-secondary);
		overflow: hidden;
	}

	.rail-top {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 0 12px 8px;
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

	/* The folder pill: a single container holding the trigger header
	   above the (animated) Collapsible.Content. The pill itself has
	   constant width, bg, radius, and padding in both states — only the
	   Content's height animates. Keeping every other property static
	   eliminates the layered-transition jitter that comes from
	   transitioning padding/radius/trigger-size at the same time as the
	   bits-ui height keyframes. */
	.folder-pill {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 40px;
		padding: 0;
		background: var(--color-bg-tertiary);
		border-radius: 14px;
		margin: 2px 0;
	}

	/* Active-bar indicator when the selected repo lives inside a
	   collapsed folder. Hides when expanded — at that point each child's
	   own indicator does the job. */
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

	/* Trigger button (rendered by Collapsible.Trigger). Sized identically
	   in both states so the gradient avatar (with or without the count chip)
	   doesn't cause the pill above it to jump. Only background-color
	   transitions on hover; nothing about the trigger itself animates
	   during open/close. */
	:global(.folder-pill-trigger) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: none;
		border-radius: 9px;
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

	/* Collapsed-trigger inner: 28×28 avatar with the count chip. The
	   chip's outer border matches the pill bg so it visually punches
	   through the avatar's corner. */
	.folder-pill-header {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 7px;
		background: var(--color-bg-secondary);
	}

	.folder-pill-avatar {
		width: 28px;
		height: 28px;
		border-radius: 7px;
		object-fit: cover;
		display: block;
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
		right: -4px;
		bottom: -4px;
		min-width: 16px;
		height: 14px;
		padding: 0 4px;
		border-radius: 8px;
		background: var(--color-bg-secondary);
		border: 1.5px solid var(--color-bg-tertiary);
		color: var(--color-text-secondary);
		font-size: 9px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 11px;
		text-align: center;
	}

	/* Collapsible.Content animation. bits-ui injects the natural content
	   height into `--bits-collapsible-content-height` once mounted, which
	   lets the keyframes interpolate between 0 and the real height for
	   both directions. `overflow: hidden` clips the children during the
	   animation. Reduced-motion is handled globally in app.css. */
	:global(.folder-pill-content) {
		overflow: hidden;
		width: 100%;
	}

	:global(.folder-pill-content[data-state='open']) {
		animation: folder-pill-content-down var(--duration-quick) var(--ease-out-expo);
	}

	:global(.folder-pill-content[data-state='closed']) {
		animation: folder-pill-content-up var(--duration-quick) var(--ease-out-expo);
	}

	@keyframes folder-pill-content-down {
		from {
			height: 0;
		}
		to {
			height: var(--bits-collapsible-content-height);
		}
	}

	@keyframes folder-pill-content-up {
		from {
			height: var(--bits-collapsible-content-height);
		}
		to {
			height: 0;
		}
	}

	/* Vertical padding sits on the inner content (not the pill) so the
	   pill is exactly 40 × 40 when collapsed — matching a standalone
	   repo tile — and only grows by the breathing room when expanded. */
	.folder-pill-content-inner {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 6px 0;
	}

	/* In-pill active ring: the default RepoAvatarButton ring is a
	   2 px bg-secondary "gap" + 3.5 px accent, tuned for the rail's
	   bg-secondary background. Inside the pill (bg-tertiary) the
	   bg-secondary stripe reads as a darker frame asymmetric against
	   the lighter pill bg — the avatar looks off-center inside the
	   ring. A single solid accent ring sits flush against the avatar,
	   so the centering reads cleanly. */
	:global(.folder-pill-content .repo-button--active .avatar) {
		box-shadow: 0 0 0 2px var(--color-accent, var(--color-text-primary));
	}

	.rail-bottom {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		height: 40px;
		flex-shrink: 0;
		padding: 0 12px;
		border-top: 1px solid var(--color-border);
	}

	.rail-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: none;
		border-radius: 9px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap);
	}

	.rail-action:hover {
		background: var(--color-bg-elevated);
		color: var(--color-text-primary);
	}

	.rail-action--add {
		margin-top: 8px;
		border: 1px dashed var(--color-border);
	}

	.rail-action--add:hover {
		border-color: var(--color-border-focus, var(--color-accent));
		color: var(--color-accent, var(--color-text-primary));
	}

	.user-slot {
		width: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
</style>
