<script lang="ts">
import CircleDashed from "phosphor-svelte/lib/CircleDashed";
import UserFocus from "phosphor-svelte/lib/UserFocus";
import VerdictGlyph from "$lib/components/conversation/VerdictGlyph.svelte";
import FilterOption from "$lib/components/shared/filter-popover/FilterOption.svelte";
import FilterOptionAvatar from "$lib/components/shared/filter-popover/FilterOptionAvatar.svelte";
import FilterPopoverContent from "$lib/components/shared/filter-popover/FilterPopoverContent.svelte";
import FilterSectionHeader from "$lib/components/shared/filter-popover/FilterSectionHeader.svelte";
import * as Popover from "$lib/components/ui/popover";
import { Switch } from "$lib/components/ui/switch";
import type { OwnerGroup } from "$lib/conversation/codeowners-review";

// Which CODEOWNERS owners the files sidebar is scoped to, next to the file
// search: the viewer's own groups (narrowest first, checked by default) and
// everyone else's, each with its file count and where its approval stands.
// The scope marks its files in the tree; "Only these files" hides the rest.

interface Props {
  groups: readonly OwnerGroup[];
  scope: ReadonlySet<string>;
  /** Changed files the scope covers. */
  scopedCount: number;
  onlyScope: boolean;
  ontoggle: (owner: string) => void;
  onOnlyScope: (value: boolean) => void;
  onreset: () => void;
  /** The scope is not the default one. */
  customized: boolean;
}

let { groups, scope, scopedCount, onlyScope, ontoggle, onOnlyScope, onreset, customized }: Props =
  $props();

let open = $state(false);
let mineCollapsed = $state(false);
let othersCollapsed = $state(true);

const mine = $derived(groups.filter((g) => g.mine));
const others = $derived(groups.filter((g) => !g.mine));

/** `merkl-rnd` for `@Merkl/merkl-rnd`: the org is the same on every row. */
function shortName(group: OwnerGroup): string {
  return group.team ? (group.handle.split("/").pop() ?? group.handle) : group.handle;
}

function statusTitle(group: OwnerGroup): string {
  const who = (logins: readonly string[]) => logins.map((l) => `@${l}`).join(", ");
  switch (group.status) {
    case "approved":
      return `${group.owner}: approved by ${who(group.approvedBy)}`;
    case "changes_requested":
      return `${group.owner}: changes requested by ${who(group.changesRequestedBy)}`;
    case "pending":
      return `${group.owner}: no approval yet`;
  }
}
</script>

{#snippet row(group: OwnerGroup)}
	<FilterOption
		checked={scope.has(group.owner)}
		label={shortName(group)}
		title={statusTitle(group)}
		count={group.files.length}
		onclick={() => ontoggle(group.owner)}
	>
		{#snippet leading()}
			<FilterOptionAvatar kind={group.team ? 'team' : 'user'} />
		{/snippet}
		{#snippet trailing()}
			{#if group.status === 'pending'}
				<CircleDashed size={12} weight="bold" class="scope-pending" aria-label="No approval yet" />
			{:else}
				<VerdictGlyph verdict={group.status} size={12} />
			{/if}
		{/snippet}
	</FilterOption>
{/snippet}

<Popover.Root bind:open>
	<!-- `.filter-trigger` is the sidebar's filter button (AuthorFilter), so both read alike. -->
	<Popover.Trigger
		class={`filter-trigger${onlyScope ? ' filter-trigger--active' : ''}`}
		aria-label="Scope files to code owners"
		title={onlyScope ? `Showing ${scopedCount} owned files` : 'Scope files to code owners'}
	>
		<UserFocus size={13} weight={onlyScope ? 'fill' : 'regular'} aria-hidden="true" />
		{#if onlyScope}
			<span class="scope-badge">{scopedCount}</span>
		{/if}
	</Popover.Trigger>

	<FilterPopoverContent title="Code owners" onclear={customized ? onreset : undefined}>
		<div class="scope-only">
			<span>Only these files</span>
			<Switch checked={onlyScope} onCheckedChange={onOnlyScope} aria-label="Only show these files" />
		</div>
		{#if mine.length > 0}
			<FilterSectionHeader
				label="Yours"
				count={mine.length}
				collapsed={mineCollapsed}
				ontoggle={() => (mineCollapsed = !mineCollapsed)}
			/>
			{#if !mineCollapsed}
				<div class="scope-list">
					{#each mine as group (group.owner)}
						{@render row(group)}
					{/each}
				</div>
			{/if}
		{/if}
		{#if others.length > 0}
			<FilterSectionHeader
				label="Other owners"
				count={others.length}
				collapsed={othersCollapsed}
				ontoggle={() => (othersCollapsed = !othersCollapsed)}
			/>
			{#if !othersCollapsed}
				<div class="scope-list">
					{#each others as group (group.owner)}
						{@render row(group)}
					{/each}
				</div>
			{/if}
		{/if}
	</FilterPopoverContent>
</Popover.Root>

<style>
	.scope-badge {
		min-width: 12px;
		font-size: 10px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1;
		text-align: center;
	}

	.scope-only {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 2px 6px 6px;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.scope-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	:global(.scope-pending) {
		color: var(--color-warning);
	}
</style>
