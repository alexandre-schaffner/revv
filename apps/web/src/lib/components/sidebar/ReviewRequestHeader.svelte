<script lang="ts">
import CaretRight from "phosphor-svelte/lib/CaretRight";
import CircleDashed from "phosphor-svelte/lib/CircleDashed";
import Funnel from "phosphor-svelte/lib/Funnel";
import UserFocus from "phosphor-svelte/lib/UserFocus";
import UsersThree from "phosphor-svelte/lib/UsersThree";
import VerdictGlyph from "$lib/components/conversation/VerdictGlyph.svelte";
import {
  fileShare,
  type OwnerGroup,
  type ReviewOwnership,
  reasonText,
} from "$lib/conversation/codeowners-review";
import { gsapSlide } from "$lib/motion";

// Why the viewer is asked to review this PR, above the file tree: the
// CODEOWNERS rule (or the person) that asked, how many files are theirs, a
// "Needs me" filter for those, and where each owner group's approval stands.

interface Props {
  ownership: ReviewOwnership;
  /** Where the rules came from, e.g. `.github/CODEOWNERS on main`. Null without a file. */
  source: string | null;
  needsMeOnly: boolean;
  onToggleNeedsMe: () => void;
}

let { ownership, source, needsMeOnly, onToggleNeedsMe }: Props = $props();

const reason = $derived(ownership.reason);
const owned = $derived(ownership.mine.size);
const myGroups = $derived(ownership.groups.filter((g) => g.mine));
const otherGroups = $derived(ownership.groups.filter((g) => !g.mine));
let othersOpen = $state(false);

function statusTitle(group: OwnerGroup): string {
  switch (group.status) {
    case "approved":
      return `Approved by ${group.approvedBy.map((l) => `@${l}`).join(", ")}`;
    case "changes_requested":
      return `Changes requested by ${group.changesRequestedBy.map((l) => `@${l}`).join(", ")}`;
    case "pending":
      return "Awaiting an owner's review";
  }
}

/** For a team, the member whose review answered for it. */
function answeredBy(group: OwnerGroup): string | null {
  if (!group.team) return null;
  const who = group.status === "changes_requested" ? group.changesRequestedBy : group.approvedBy;
  return who.length > 0 ? `@${who.join(", @")}` : null;
}
</script>

{#snippet groupRow(group: OwnerGroup)}
	{@const by = answeredBy(group)}
	<li class="rr-group" title="{group.owner}: {statusTitle(group)}">
		<span class="rr-status" aria-label={statusTitle(group)} role="img">
			{#if group.status === 'pending'}
				<CircleDashed size={12} weight="bold" class="rr-pending" />
			{:else}
				<VerdictGlyph verdict={group.status} size={12} />
			{/if}
		</span>
		{#if group.team}
			<UsersThree size={12} class="rr-kind" />
		{/if}
		<span class="rr-handle">{group.handle}</span>
		{#if by}
			<span class="rr-by">{by}</span>
		{/if}
		<span class="rr-count">{group.files.length}</span>
	</li>
{/snippet}

{#if reason}
	<section class="rr" aria-label="Why you're asked to review">
		<div class="rr-head">
			<UserFocus size={14} class="rr-icon" />
			<p class="rr-reason">
				<span>{reasonText(reason)}</span>
				{#if owned > 0}
					<span class="rr-share">{fileShare(owned, ownership.totalFiles)}</span>
				{/if}
			</p>
			{#if owned > 0}
				<button
					type="button"
					class="rr-toggle"
					class:rr-toggle--on={needsMeOnly}
					aria-pressed={needsMeOnly}
					title={needsMeOnly ? 'Show every changed file' : 'Show only the files you own'}
					onclick={onToggleNeedsMe}
				>
					<Funnel size={11} weight={needsMeOnly ? 'fill' : 'regular'} />
					Needs me
				</button>
			{/if}
		</div>

		{#if ownership.groups.length > 0}
			<ul class="rr-groups" title={source ? `Read from ${source}` : undefined}>
				{#each myGroups as group (group.owner)}
					{@render groupRow(group)}
				{/each}
			</ul>
			{#if otherGroups.length > 0}
				<button
					type="button"
					class="rr-others"
					aria-expanded={othersOpen}
					onclick={() => (othersOpen = !othersOpen)}
				>
					<span class="rr-caret" class:rr-caret--open={othersOpen}>
						<CaretRight size={9} weight="bold" />
					</span>
					{otherGroups.length} other {otherGroups.length === 1 ? 'owner' : 'owners'}
				</button>
				{#if othersOpen}
					<ul class="rr-groups" transition:gsapSlide>
						{#each otherGroups as group (group.owner)}
							{@render groupRow(group)}
						{/each}
					</ul>
				{/if}
			{/if}
		{/if}
	</section>
{/if}

<style>
	.rr {
		margin: 0 12px 6px;
		padding: 8px 10px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-bg-elevated);
	}

	.rr-head {
		display: flex;
		align-items: flex-start;
		gap: 6px;
	}

	.rr-head :global(.rr-icon) {
		flex-shrink: 0;
		margin-top: 1px;
		color: var(--color-accent);
	}

	.rr-reason {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.35;
		color: var(--color-text-primary);
		overflow-wrap: anywhere;
	}

	.rr-share {
		font-size: 0.6875rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.rr-toggle {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 4px;
		height: 22px;
		padding: 0 8px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: none;
		font: inherit;
		font-size: 0.6875rem;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.rr-toggle:hover {
		color: var(--color-text-primary);
		background: var(--color-tree-hover-bg);
	}

	.rr-toggle--on {
		border-color: var(--color-accent-chip-border);
		background: var(--color-accent-chip-bg);
		color: var(--color-accent-chip-fg);
	}

	.rr-toggle--on:hover {
		border-color: var(--color-accent-chip-border-hover);
		background: var(--color-accent-chip-bg-hover);
		color: var(--color-accent-chip-fg);
	}

	.rr-groups {
		margin: 6px 0 0;
		padding: 0;
		list-style: none;
	}

	.rr-group {
		display: flex;
		align-items: center;
		gap: 5px;
		min-height: 20px;
		font-size: 0.6875rem;
		color: var(--color-text-secondary);
	}

	.rr-status {
		display: inline-flex;
		flex-shrink: 0;
	}

	.rr-status :global(.rr-pending) {
		color: var(--color-warning);
	}

	.rr-group :global(.rr-kind) {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.rr-handle {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-primary);
	}

	.rr-by {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-muted);
	}

	.rr-count {
		flex-shrink: 0;
		margin-left: auto;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.rr-others {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-top: 4px;
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		font-size: 0.6875rem;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.rr-others:hover {
		color: var(--color-text-secondary);
	}

	.rr-caret {
		display: inline-flex;
	}

	.rr-caret--open {
		rotate: 90deg;
	}
</style>
