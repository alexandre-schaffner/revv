<script lang="ts">
	import {
		Root as PopoverRoot,
		Trigger as PopoverTrigger,
		Content as PopoverContent,
	} from '$lib/components/ui/popover/index.js';
	import { Building2, Check, ChevronDown, User } from '@lucide/svelte';
	import {
		getAvailableOrgs,
		getActiveOrg,
		setActiveOrg,
	} from '$lib/stores/orgs.svelte';
	import { getUser, getCurrentUserLogin } from '$lib/stores/auth.svelte';

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
		const fallback = personalLogin ?? orgs[0]?.login ?? null;
		if (fallback) setActiveOrg(fallback);
	});

	const activeOrgRow = $derived(
		activeOrg ? orgs.find((o) => o.login === activeOrg) ?? null : null,
	);
	const isPersonalActive = $derived(
		activeOrg !== null && personalLogin !== null && activeOrg === personalLogin,
	);

	function select(login: string): void {
		setActiveOrg(login);
		open = false;
	}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger class={collapsed ? 'org-trigger org-trigger--collapsed' : 'org-trigger'}>
		{#if isPersonalActive}
			{#if user?.image}
				<img src={user.image} alt="" class={collapsed ? 'org-trigger-avatar org-trigger-avatar--collapsed' : 'org-trigger-avatar'} referrerpolicy="no-referrer" />
			{:else}
				<User size={collapsed ? 14 : 16} class="org-trigger-icon" />
			{/if}
			{#if !collapsed}
				<span class="org-trigger-label">{personalLogin}</span>
			{/if}
		{:else if activeOrgRow}
			{#if activeOrgRow.avatarUrl}
				<img src={activeOrgRow.avatarUrl} alt="" class={collapsed ? 'org-trigger-avatar org-trigger-avatar--collapsed' : 'org-trigger-avatar'} referrerpolicy="no-referrer" />
			{:else}
				<Building2 size={collapsed ? 14 : 16} class="org-trigger-icon" />
			{/if}
			{#if !collapsed}
				<span class="org-trigger-label">{activeOrgRow.login}</span>
			{/if}
		{:else if activeOrg}
			<Building2 size={collapsed ? 14 : 16} class="org-trigger-icon" />
			{#if !collapsed}
				<span class="org-trigger-label">{activeOrg}</span>
			{/if}
		{:else if user}
			{#if user.image}
				<img src={user.image} alt="" class={collapsed ? 'org-trigger-avatar org-trigger-avatar--collapsed' : 'org-trigger-avatar'} referrerpolicy="no-referrer" />
			{:else}
				<User size={collapsed ? 14 : 16} class="org-trigger-icon" />
			{/if}
			{#if !collapsed && user.name}
				<span class="org-trigger-label">{user.name}</span>
			{/if}
		{:else}
			<Building2 size={collapsed ? 14 : 16} class="org-trigger-icon" />
			{#if !collapsed}
				<span class="org-trigger-label">Revv</span>
			{/if}
		{/if}
		{#if !collapsed}
			<ChevronDown size={14} class="org-trigger-caret" />
		{/if}
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
		transition:
			background-color var(--duration-snap),
			width var(--duration-snap) var(--ease-out-expo),
			height var(--duration-snap) var(--ease-out-expo),
			padding var(--duration-snap) var(--ease-out-expo),
			border-radius var(--duration-snap) var(--ease-out-expo);
	}

	:global(.org-trigger:hover) {
		background: var(--color-bg-elevated);
	}

	:global(.org-trigger--collapsed) {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		margin: 0 auto;
		border-radius: 4px;
		gap: 0;
		flex: none;
	}

	:global(.org-trigger-avatar) {
		width: 22px;
		height: 22px;
		border-radius: 5px;
		object-fit: cover;
		flex-shrink: 0;
		transition:
			width var(--duration-snap) var(--ease-out-expo),
			height var(--duration-snap) var(--ease-out-expo),
			border-radius var(--duration-snap) var(--ease-out-expo);
	}

	:global(.org-trigger-avatar--collapsed) {
		width: 18px;
		height: 18px;
		border-radius: 4px;
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
</style>
