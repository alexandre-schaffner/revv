<script lang="ts">
import CaretDown from "phosphor-svelte/lib/CaretDown";
import GitBranch from "phosphor-svelte/lib/GitBranch";
import SquaresFour from "phosphor-svelte/lib/SquaresFour";
import UsersThree from "phosphor-svelte/lib/UsersThree";
import { untrack } from "svelte";
import FilterOption from "$lib/components/shared/filter-popover/FilterOption.svelte";
import FilterOptionAvatar from "$lib/components/shared/filter-popover/FilterOptionAvatar.svelte";
import FilterPopoverContent from "$lib/components/shared/filter-popover/FilterPopoverContent.svelte";
import FilterSectionHeader from "$lib/components/shared/filter-popover/FilterSectionHeader.svelte";
import FilterStateRow from "$lib/components/shared/filter-popover/FilterStateRow.svelte";
import * as Popover from "$lib/components/ui/popover";
import { gsapPress } from "$lib/motion";

import {
  fetchTeamsForOrg,
  getTeamsFetchStateForOrg,
  getTeamsForOrg,
} from "$lib/stores/org-teams.svelte";
import { getRepositories } from "$lib/stores/repos.svelte";

interface Props {
  value: string;
  label: string;
  onChange: (value: string) => void;
}
let { value, label, onChange }: Props = $props();
let open = $state(false);
let query = $state("");
let teamsCollapsed = $state(false);
let reposCollapsed = $state(false);
const repos = $derived(getRepositories());
const owners = $derived([...new Set(repos.map((repo) => repo.owner))]);
const needle = $derived(query.trim().toLowerCase());
const filteredRepos = $derived(repos.filter((r) => r.fullName.toLowerCase().includes(needle)));
const teams = $derived(
  owners.flatMap((owner) =>
    getTeamsForOrg(owner).map((team) => ({
      value: `team:${owner}/${team.slug}`,
      label: team.name,
      owner,
    })),
  ),
);
const filteredTeams = $derived(
  teams.filter((team) => `${team.owner} ${team.label}`.toLowerCase().includes(needle)),
);

$effect(() => {
  for (const owner of owners)
    untrack(() => {
      void fetchTeamsForOrg(owner);
    });
});
function choose(next: string): void {
  open = false;
  query = "";
  onChange(next);
}
</script>

<div class="scope-anchor" use:gsapPress>
  <Popover.Root bind:open>
    <Popover.Trigger class="recap-scope-trigger" aria-label="Recap scope: {label}">
      {#if value === "all"}<SquaresFour size={13} />{:else if value.startsWith("team:")}<UsersThree size={13} />{:else}<GitBranch size={13} />{/if}
      <span class="scope-label">{label}</span>
      <CaretDown size={10} aria-hidden="true" />
    </Popover.Trigger>
    <FilterPopoverContent title="Filter recap" bind:query placeholder="Search teams and repositories" onclear={value !== "all" ? () => choose("all") : undefined}>
      <p class="scope-hint">Teams are matched by PR authors’ GitHub memberships.</p>
      {#if !needle || "everything".includes(needle)}
        <FilterOption checked={value === "all"} label="Everything" onclick={() => choose("all")}>
          {#snippet leading()}<SquaresFour size={14} />{/snippet}
        </FilterOption>
      {/if}
      <FilterSectionHeader label="Teams" count={filteredTeams.length} collapsed={teamsCollapsed} ontoggle={() => teamsCollapsed = !teamsCollapsed} />
      {#if !teamsCollapsed}
        {#each filteredTeams as team (team.value)}
          <FilterOption checked={value === team.value} label={team.label} title={`GitHub team: ${team.owner} / ${team.label}`} onclick={() => choose(team.value)}>
            {#snippet leading()}<FilterOptionAvatar kind="team" />{/snippet}
          </FilterOption>
        {/each}
        {#each owners.filter((owner) => getTeamsFetchStateForOrg(owner) === "error") as owner (owner)}
          <FilterStateRow message={`${owner} teams unavailable`} action={{ label: "Retry", run: () => { void fetchTeamsForOrg(owner, { force: true }); } }} />
        {/each}
        {#if owners.some((owner) => getTeamsFetchStateForOrg(owner) === "loading")}<FilterStateRow message="Loading teams" loading />
        {:else if !filteredTeams.length}<FilterStateRow message="No matching teams" />{/if}
      {/if}
      <FilterSectionHeader label="Repositories" count={filteredRepos.length} collapsed={reposCollapsed} ontoggle={() => reposCollapsed = !reposCollapsed} />
      {#if !reposCollapsed}
        {#each filteredRepos as repo (repo.id)}
          <FilterOption checked={value === `repo:${repo.id}`} label={repo.name} title={repo.fullName} onclick={() => choose(`repo:${repo.id}`)}>
            {#snippet leading()}<GitBranch size={14} />{/snippet}
          </FilterOption>
        {:else}<FilterStateRow message="No matching repositories" />{/each}
      {/if}
    </FilterPopoverContent>
  </Popover.Root>
</div>

<style>
.scope-hint { margin: .25rem .25rem .5rem; font-size: var(--text-xs); line-height: 1.5; color: var(--color-text-secondary); }
.scope-anchor { position: absolute; left: 0; top: 50%; transform: translateY(-50%); pointer-events: auto; }
:global(.recap-scope-trigger) { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; height: 30px; max-width: 172px; padding: 0 .75rem; border: 1px solid var(--color-glass-border); border-radius: 999px; background: var(--color-tab-track-bg); box-shadow: var(--color-glass-shadow), inset 0 .5px 0 var(--color-glass-highlight); color: var(--color-text-secondary); font: inherit; font-size: var(--text-xs); white-space: nowrap; cursor: pointer; }
:global(.recap-scope-trigger:hover), :global(.recap-scope-trigger[data-state="open"]) { color: var(--color-text-primary); background: var(--color-bg-tertiary); }
:global(.recap-scope-trigger:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 3px; }
.scope-label { overflow: hidden; text-overflow: ellipsis; max-width: 115px; }
</style>
