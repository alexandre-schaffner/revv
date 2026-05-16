<script lang="ts">
import { Building2, Check, ChevronDown, Globe, User } from "@lucide/svelte";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import { getCurrentUserLogin, getUser } from "$lib/stores/auth.svelte";
import { getActiveOrg, getAvailableOrgs, setActiveOrg } from "$lib/stores/orgs.svelte";
import { getRepositories } from "$lib/stores/prs.svelte";

interface Props {
  collapsed?: boolean;
}

let { collapsed = false }: Props = $props();

let open = $state(false);

const orgs = $derived(getAvailableOrgs());
const activeOrg = $derived(getActiveOrg());
const user = $derived(getUser());
const personalLogin = $derived(getCurrentUserLogin());

// With no "All organizations" option, the switcher must always have a
// concrete selection. As soon as we know enough to pick a default
// (orgs loaded or a personal login surfaces), promote `activeOrg` from
// null to the personal login (preferred) or the first org. localStorage
// then persists the user's explicit choice across sessions.
$effect(() => {
  if (activeOrg !== null) return;
  const repos = getRepositories();
  const repoOwner = repos[0]?.owner ?? null;
  const allKnownOwners = [personalLogin, ...orgs.map((o) => o.login), ...externalOwners].filter(
    Boolean,
  );
  const repoFallback = repoOwner && allKnownOwners.includes(repoOwner) ? repoOwner : null;
  const fallback = repoFallback ?? personalLogin ?? orgs[0]?.login ?? null;
  if (fallback) setActiveOrg(fallback);
});

const knownOwners = $derived(
  new Set([personalLogin, ...orgs.map((o) => o.login)].filter((x): x is string => Boolean(x))),
);
const externalOwners = $derived(
  [...new Set(getRepositories().map((r) => r.owner).filter((o) => !knownOwners.has(o)))].sort(),
);

const activeOrgRow = $derived(activeOrg ? (orgs.find((o) => o.login === activeOrg) ?? null) : null);
const isPersonalActive = $derived(
  activeOrg !== null && personalLogin !== null && activeOrg === personalLogin,
);
const isExternalActive = $derived(
  activeOrg !== null &&
    !isPersonalActive &&
    activeOrgRow === null &&
    externalOwners.includes(activeOrg),
);

function select(login: string): void {
  setActiveOrg(login);
  open = false;
}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger class={collapsed ? 'org-trigger org-trigger--collapsed' : 'org-trigger'}>
		<!-- Icon/avatar: always visible -->
		{#if isPersonalActive}
			{#if user?.image}
				<img src={user.image} alt="" class={collapsed ? 'org-trigger-avatar org-trigger-avatar--collapsed' : 'org-trigger-avatar'} referrerpolicy="no-referrer" />
			{:else}
				<User size={16} class="org-trigger-icon" />
			{/if}
		{:else if activeOrgRow}
			{#if activeOrgRow.avatarUrl}
				<img src={activeOrgRow.avatarUrl} alt="" class={collapsed ? 'org-trigger-avatar org-trigger-avatar--collapsed' : 'org-trigger-avatar'} referrerpolicy="no-referrer" />
			{:else}
				<Building2 size={16} class="org-trigger-icon" />
			{/if}
		{:else if activeOrg}
			<Globe size={16} class="org-trigger-icon" />
		{:else if user}
			{#if user.image}
				<img src={user.image} alt="" class={collapsed ? 'org-trigger-avatar org-trigger-avatar--collapsed' : 'org-trigger-avatar'} referrerpolicy="no-referrer" />
			{:else}
				<User size={16} class="org-trigger-icon" />
			{/if}
		{:else}
			<Building2 size={16} class="org-trigger-icon" />
		{/if}

		<!-- Label + caret: always in DOM, collapsed via max-width+opacity -->
		<span class="org-trigger-content" class:org-trigger-content--hidden={collapsed} aria-hidden={collapsed || undefined}>
			{#if isPersonalActive}
				<span class="org-trigger-label">{personalLogin}</span>
			{:else if activeOrgRow}
				<span class="org-trigger-label">{activeOrgRow.login}</span>
			{:else if activeOrg}
				<span class="org-trigger-label">{activeOrg}</span>
			{:else if user?.name}
				<span class="org-trigger-label">{user.name}</span>
			{:else}
				<span class="org-trigger-label">Revv</span>
			{/if}
			<ChevronDown size={14} class="org-trigger-caret" />
		</span>
	</PopoverTrigger>
	<PopoverContent
		class={collapsed ? 'w-60 p-1' : 'p-1'}
		style={collapsed ? undefined : 'width: var(--bits-popover-anchor-width)'}
		align="start"
		side="bottom"
	>
		{#if personalLogin}
			<button class="org-row" onclick={() => select(personalLogin)}>
				{#if user?.image}
					<img src={user.image} alt="" class="org-row-avatar" referrerpolicy="no-referrer" />
				{:else}
					<User size={14} class="org-row-icon" />
				{/if}
				<span class="org-row-label">{personalLogin}</span>
				<span class="org-row-tag">Personal</span>
				{#if isPersonalActive}
					<Check size={12} class="org-row-check" />
				{/if}
			</button>
		{/if}

		{#if orgs.length > 0}
			{#if personalLogin}
				<div class="org-divider"></div>
			{/if}
			{#each orgs as org (org.login)}
				<button class="org-row" onclick={() => select(org.login)}>
					{#if org.avatarUrl}
						<img src={org.avatarUrl} alt="" class="org-row-avatar" referrerpolicy="no-referrer" />
					{:else}
						<Building2 size={14} class="org-row-icon" />
					{/if}
					<span class="org-row-label">{org.login}</span>
					{#if activeOrg === org.login && !isPersonalActive}
						<Check size={12} class="org-row-check" />
					{/if}
				</button>
			{/each}
		{/if}

		{#if externalOwners.length > 0}
			<div class="org-divider"></div>
			<span class="org-section-label">External</span>
			{#each externalOwners as owner (owner)}
				<button class="org-row" onclick={() => select(owner)}>
					<Globe size={14} class="org-row-icon" />
					<span class="org-row-label">{owner}</span>
					{#if activeOrg === owner}
						<Check size={12} class="org-row-check" />
					{/if}
				</button>
			{/each}
		{/if}
	</PopoverContent>
</PopoverRoot>

<style>
	:global(.org-trigger) {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 1;
		min-width: 0;
		height: 38px;
		padding: 0 10px;
		border: none;
		border-radius: 7px;
		background: transparent;
		color: var(--color-text-primary);
		cursor: pointer;
		text-align: left;
		overflow: hidden;
		transition:
			background-color var(--duration-snap),
			gap var(--duration-smooth) var(--ease-out-expo),
			padding var(--duration-smooth) var(--ease-out-expo),
			border-radius var(--duration-smooth) var(--ease-out-expo);
	}

	:global(.org-trigger:hover) {
		background: var(--color-bg-elevated);
	}

	:global(.org-trigger--collapsed) {
		padding: 0;
		gap: 0;
	}

	:global(.org-trigger-avatar) {
		width: 22px;
		height: 22px;
		border-radius: 5px;
		object-fit: cover;
		flex-shrink: 0;
	}

	:global(.org-trigger-avatar--collapsed) {
		/* No size change — parent shrink handles the visual effect */
	}

	:global(.org-trigger-icon) {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	:global(.org-trigger-label) {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-primary);
		font-size: 14px;
		font-weight: 600;
	}

	/* Label + caret wrapper — expand path: fade in after column leads (80ms delay) */
	:global(.org-trigger-content) {
		display: flex;
		align-items: center;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		max-width: 9999px;
		opacity: 1;
		visibility: visible;
		transition:
			opacity var(--duration-quick) var(--ease-out-expo) 80ms,
			max-width var(--duration-smooth) var(--ease-out-expo) 80ms,
			visibility 0s linear 0s;
	}

	/* Collapse path: label+caret fade + collapse ahead of the column */
	:global(.org-trigger-content--hidden) {
		opacity: 0;
		visibility: hidden;
		max-width: 0;
		pointer-events: none;
		transition:
			opacity var(--duration-quick) var(--ease-soft),
			max-width var(--duration-smooth) var(--ease-out-expo),
			visibility 0s linear var(--duration-quick);
	}

	:global(.org-trigger-caret) {
		flex-shrink: 0;
		margin-left: auto;
		color: var(--color-text-muted);
	}

	:global(.org-row) {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border: none;
		border-radius: 5px;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		text-align: left;
		font-size: 12px;
		transition: background-color var(--duration-snap);
	}

	:global(.org-row:hover) {
		background: var(--color-bg-tertiary);
	}

	:global(.org-row-avatar) {
		width: 16px;
		height: 16px;
		border-radius: 3px;
		object-fit: cover;
		flex-shrink: 0;
	}

	:global(.org-row-icon) {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	:global(.org-row-label) {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.org-row-tag) {
		font-size: 10px;
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	:global(.org-row-check) {
		flex-shrink: 0;
		color: var(--color-accent);
	}

	:global(.org-divider) {
		height: 1px;
		margin: 4px 6px;
		background: var(--color-border);
	}

	:global(.org-section-label) {
		display: block;
		padding: 4px 8px 2px;
		font-size: 10px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}
</style>
