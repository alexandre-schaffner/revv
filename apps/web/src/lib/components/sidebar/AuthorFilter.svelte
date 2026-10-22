<script lang="ts">
import Funnel from "phosphor-svelte/lib/Funnel";
import FilterOption from "$lib/components/shared/filter-popover/FilterOption.svelte";
import FilterOptionAvatar from "$lib/components/shared/filter-popover/FilterOptionAvatar.svelte";
import FilterPopoverContent from "$lib/components/shared/filter-popover/FilterPopoverContent.svelte";
import FilterSectionHeader from "$lib/components/shared/filter-popover/FilterSectionHeader.svelte";
import FilterStateRow from "$lib/components/shared/filter-popover/FilterStateRow.svelte";
import * as Popover from "$lib/components/ui/popover";
import {
  clearAuthorFilters,
  fetchTeamsForOrg,
  getAuthorFilterOptions,
  getRepoOwner,
  getSelectedAuthorLogins,
  getTeamsFetchStateForOrg,
  getTeamsForOrg,
  setAuthorFilters,
  toggleAuthorFilter,
} from "$lib/stores/prs.svelte";

interface Props {
  repoId?: string;
}

let { repoId }: Props = $props();
let open = $state(false);
let teamsCollapsed = $state(false);
let creatorsCollapsed = $state(false);
let creatorQuery = $state("");

const options = $derived(getAuthorFilterOptions(repoId));
const normalizedCreatorQuery = $derived(creatorQuery.trim().toLowerCase());
const visibleOptions = $derived(
  normalizedCreatorQuery === ""
    ? options
    : options.filter((option) => option.login.toLowerCase().includes(normalizedCreatorQuery)),
);
const selected = $derived(getSelectedAuthorLogins());
const selectedCount = $derived(selected.size);
const selectedLabel = $derived(
  selectedCount === 0
    ? "Creators"
    : selectedCount === 1
      ? [...selected][0]
      : `${selectedCount} creators`,
);

// Teams for the repo's owning org, narrowed to members who actually have an
// open PR here — a team you can't filter anyone down to isn't worth showing.
const owner = $derived(repoId ? getRepoOwner(repoId) : null);
const teamsFetchState = $derived(owner ? getTeamsFetchStateForOrg(owner) : "idle");
const optionLoginByKey = $derived(
  new Map(options.map((option) => [option.login.toLowerCase(), option.login])),
);
const teamRows = $derived(
  (owner ? getTeamsForOrg(owner) : [])
    .map((team) => ({
      slug: team.slug,
      name: team.name,
      members: [
        ...new Set(
          team.memberLogins
            .map((login) => optionLoginByKey.get(login.toLowerCase()))
            .filter((login): login is string => login !== undefined),
        ),
      ],
    }))
    .filter((team) => team.members.length > 0)
    .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name)),
);
const showTeamsSection = $derived(
  owner !== null && (teamsFetchState !== "idle" || teamRows.length > 0),
);

// Fetch the org's teams when the repo filter mounts. The request is
// idempotent, so the popover usually opens with the team state already known.
$effect(() => {
  if (owner) void fetchTeamsForOrg(owner);
});

function isTeamChecked(members: string[]): boolean {
  return members.length > 0 && members.every((login) => selected.has(login));
}

function toggleTeam(members: string[]): void {
  setAuthorFilters(members, !isTeamChecked(members));
}

function retryTeams(): void {
  if (owner) void fetchTeamsForOrg(owner, { force: true });
}
</script>

{#snippet creatorRows()}
	{#if visibleOptions.length > 0}
		{#each visibleOptions as option (option.login)}
			<FilterOption
				checked={selected.has(option.login)}
				label={option.login}
				count={option.count}
				onclick={() => toggleAuthorFilter(option.login)}
			>
				{#snippet leading()}
					<FilterOptionAvatar kind="user" content={option.avatarContent} />
				{/snippet}
			</FilterOption>
		{/each}
	{:else}
		<FilterStateRow message="No creators match" />
	{/if}
{/snippet}

{#snippet teamStateRow()}
	{#if teamsFetchState === "loading"}
		<FilterStateRow message="Loading teams" loading />
	{:else if teamsFetchState === "error"}
		<FilterStateRow message="Teams unavailable" action={{ label: "Retry", run: retryTeams }} />
	{:else if teamRows.length === 0}
		<FilterStateRow message="No teams match current PR creators" />
	{/if}
{/snippet}

{#if options.length > 1 || showTeamsSection || selectedCount > 0}
	<Popover.Root bind:open>
		<Popover.Trigger
			class={`filter-trigger${selectedCount > 0 ? " filter-trigger--active" : ""}`}
			aria-label="Filter pull requests by creator"
			title={selectedCount > 0 ? selectedLabel : "Filter pull requests by creator"}
		>
			<Funnel size={13} weight={selectedCount > 0 ? "fill" : "regular"} aria-hidden="true" />
			{#if selectedCount > 0}
				<span class="filter-badge">{selectedCount}</span>
			{/if}
		</Popover.Trigger>

		<FilterPopoverContent
			title="Filter by creator"
			onclear={selectedCount > 0 ? clearAuthorFilters : undefined}
			bind:query={creatorQuery}
			placeholder="Search creators"
		>
			{#if showTeamsSection}
				<FilterSectionHeader
					label="Teams"
					count={teamRows.length}
					collapsed={teamsCollapsed}
					ontoggle={() => (teamsCollapsed = !teamsCollapsed)}
				/>
				{#if !teamsCollapsed}
					{#if teamRows.length > 0}
						<div class="author-list">
							{#each teamRows as team (team.slug)}
								<FilterOption
									checked={isTeamChecked(team.members)}
									label={team.name}
									title={`Everyone on @${team.name} with an open PR`}
									count={team.members.length}
									onclick={() => toggleTeam(team.members)}
								>
									{#snippet leading()}
										<FilterOptionAvatar kind="team" />
									{/snippet}
								</FilterOption>
							{/each}
						</div>
					{:else}
						{@render teamStateRow()}
					{/if}
				{/if}

				<FilterSectionHeader
					label="Creators"
					count={visibleOptions.length}
					collapsed={creatorsCollapsed}
					ontoggle={() => (creatorsCollapsed = !creatorsCollapsed)}
				/>
				{#if !creatorsCollapsed}
					<div class="author-list">{@render creatorRows()}</div>
				{/if}
			{:else}
				<div class="author-list">{@render creatorRows()}</div>
			{/if}
		</FilterPopoverContent>
	</Popover.Root>
{/if}

<style>
	/* Compact icon button living inline to the right of the search input —
	   matches the input's 28px height and pill shape. */
	:global(.filter-trigger) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 3px;
		height: 28px;
		min-width: 28px;
		flex-shrink: 0;
		padding: 0 7px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: var(--color-bg-elevated);
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	:global(.filter-trigger:hover) {
		border-color: var(--color-border-strong);
		color: var(--color-text-primary);
		background: var(--color-bg-tertiary);
	}

	/* Active = at least one creator selected. */
	:global(.filter-trigger--active) {
		border-color: var(--color-accent);
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
	}

	.filter-badge {
		min-width: 12px;
		font-size: 10px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1;
		text-align: center;
	}

	.author-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
</style>
