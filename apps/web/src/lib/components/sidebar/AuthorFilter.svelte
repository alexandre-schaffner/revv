<script lang="ts">
import CaretRight from "phosphor-svelte/lib/CaretRight";
import Check from "phosphor-svelte/lib/Check";
import Funnel from "phosphor-svelte/lib/Funnel";
import MagnifyingGlass from "phosphor-svelte/lib/MagnifyingGlass";
import Spinner from "phosphor-svelte/lib/Spinner";
import User from "phosphor-svelte/lib/User";
import UsersThree from "phosphor-svelte/lib/UsersThree";
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
let failedAvatars = $state<Set<string>>(new Set());
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

function markAvatarFailed(login: string): void {
  failedAvatars = new Set(failedAvatars).add(login);
}

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

{#snippet sectionHeader(label: string, count: number, collapsed: boolean, toggle: () => void)}
	<button
		type="button"
		class="section-header"
		onclick={toggle}
		aria-expanded={!collapsed}
	>
		<span class="caret" class:caret--open={!collapsed} aria-hidden="true">
			<CaretRight size={10} weight="bold" />
		</span>
		<span class="section-label">{label}</span>
		<span class="section-count">{count}</span>
	</button>
{/snippet}

{#snippet creatorRows()}
	{#if visibleOptions.length > 0}
		{#each visibleOptions as option (option.login)}
			{@const checked = selected.has(option.login)}
			<button
				type="button"
				class="author-option"
				class:author-option--checked={checked}
				onclick={() => toggleAuthorFilter(option.login)}
				aria-pressed={checked}
			>
				<span class="check-slot" aria-hidden="true">
					{#if checked}
						<Check size={12} weight="bold" />
					{/if}
				</span>

				{#if option.avatarContent && !failedAvatars.has(option.login)}
					<img
						src={option.avatarContent}
						alt=""
						class="avatar"
						loading="lazy"
						referrerpolicy="no-referrer"
						onerror={() => markAvatarFailed(option.login)}
					/>
				{:else}
					<span class="avatar avatar--fallback" aria-hidden="true">
						<User size={10} />
					</span>
				{/if}

				<span class="login" title={option.login}>{option.login}</span>
				<span class="count">{option.count}</span>
			</button>
		{/each}
	{:else}
		<div class="team-state-row">
			<span>No creators match</span>
		</div>
	{/if}
{/snippet}

{#snippet teamStateRow()}
	{#if teamsFetchState === "loading"}
		<div class="team-state-row">
			<Spinner size={12} class="motion-essential-spin" aria-hidden="true" />
			<span>Loading teams</span>
		</div>
	{:else if teamsFetchState === "error"}
		<button type="button" class="team-state-row team-state-row--button" onclick={retryTeams}>
			<span>Teams unavailable</span>
			<span class="team-state-action">Retry</span>
		</button>
	{:else if teamRows.length === 0}
		<div class="team-state-row">
			<span>No teams match current PR creators</span>
		</div>
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

		<Popover.Content align="end" sideOffset={6} class="author-popover">
			<div class="popover-header">
				<span class="popover-title">Filter by creator</span>
				{#if selectedCount > 0}
					<button type="button" class="popover-clear" onclick={clearAuthorFilters}>Clear</button>
				{/if}
			</div>
			<label class="creator-search">
				<MagnifyingGlass size={12} aria-hidden="true" />
				<input
					bind:value={creatorQuery}
					type="search"
					placeholder="Search creators"
					aria-label="Search creators"
					spellcheck="false"
					autocomplete="off"
				/>
			</label>

			<div class="filter-scroll">
				{#if showTeamsSection}
					{@render sectionHeader("Teams", teamRows.length, teamsCollapsed, () => {
						teamsCollapsed = !teamsCollapsed;
					})}
					{#if !teamsCollapsed}
						{#if teamRows.length > 0}
							<div class="author-list">
								{#each teamRows as team (team.slug)}
									{@const checked = isTeamChecked(team.members)}
									<button
										type="button"
										class="author-option"
										class:author-option--checked={checked}
										onclick={() => toggleTeam(team.members)}
										aria-pressed={checked}
										title={`Everyone on @${team.name} with an open PR`}
									>
										<span class="check-slot" aria-hidden="true">
											{#if checked}
												<Check size={12} weight="bold" />
											{/if}
										</span>

										<span class="avatar avatar--fallback" aria-hidden="true">
											<UsersThree size={11} />
										</span>

										<span class="login" title={team.name}>{team.name}</span>
										<span class="count">{team.members.length}</span>
									</button>
								{/each}
							</div>
						{:else}
							{@render teamStateRow()}
						{/if}
					{/if}

					{@render sectionHeader("Creators", visibleOptions.length, creatorsCollapsed, () => {
						creatorsCollapsed = !creatorsCollapsed;
					})}
					{#if !creatorsCollapsed}
						<div class="author-list">{@render creatorRows()}</div>
					{/if}
				{:else}
					<div class="author-list">{@render creatorRows()}</div>
				{/if}
			</div>
		</Popover.Content>
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

	:global(.author-popover) {
		width: min(260px, calc(var(--sidebar-width, 280px) - 24px));
		max-height: min(420px, calc(100vh - 180px));
		padding: 8px;
		gap: 8px;
	}

	.popover-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 2px 4px 4px;
	}

	.popover-title {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.popover-clear {
		font-size: 11px;
		color: var(--color-text-muted);
	}

	.popover-clear:hover {
		color: var(--color-text-primary);
	}

	.creator-search {
		display: grid;
		grid-template-columns: 14px minmax(0, 1fr);
		align-items: center;
		gap: 6px;
		min-height: 28px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 0 7px;
		background: var(--color-bg-secondary);
		color: var(--color-text-muted);
	}

	.creator-search:focus-within {
		border-color: var(--color-border-strong);
		color: var(--color-text-secondary);
	}

	.creator-search input {
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--color-text-primary);
		font-size: 11px;
		line-height: 1;
	}

	.creator-search input::placeholder {
		color: var(--color-text-muted);
	}

	/* Single scroll region for both sections: scrolling carries the user past
	   the teams and on through every creator, instead of trapping the scroll
	   inside the creators list while the teams stay pinned above it. */
	.filter-scroll {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.author-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	/* Clickable section header — toggles its list open/closed. */
	.section-header {
		display: flex;
		align-items: center;
		gap: 5px;
		width: 100%;
		padding: 3px 4px;
		border-radius: 6px;
		color: var(--color-text-muted);
		text-align: left;
	}

	.section-header:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.caret {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: transform 0.12s ease;
	}

	.caret--open {
		transform: rotate(90deg);
	}

	.section-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.section-count {
		min-width: 18px;
		margin-left: auto;
		border-radius: 999px;
		padding: 1px 6px;
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}

	.author-option {
		display: grid;
		grid-template-columns: 14px 18px minmax(0, 1fr) auto;
		align-items: center;
		gap: 7px;
		width: 100%;
		min-height: 30px;
		border-radius: 6px;
		padding: 4px 6px;
		color: var(--color-text-secondary);
		text-align: left;
	}

	.author-option:hover,
	.author-option--checked {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.team-state-row {
		display: flex;
		align-items: center;
		gap: 7px;
		min-height: 30px;
		padding: 4px 6px 4px 21px;
		border-radius: 6px;
		color: var(--color-text-muted);
		font-size: 11px;
		text-align: left;
	}

	.team-state-row--button {
		width: 100%;
		justify-content: space-between;
	}

	.team-state-row--button:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.team-state-action {
		color: var(--color-accent);
		font-weight: 600;
	}

	.check-slot {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--color-accent);
	}

	.avatar {
		width: 18px;
		height: 18px;
		border-radius: 999px;
		object-fit: cover;
	}

	.avatar--fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
	}

	.login {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
	}

	.count {
		min-width: 20px;
		border-radius: 999px;
		padding: 1px 6px;
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}
</style>
