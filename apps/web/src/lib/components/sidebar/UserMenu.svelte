<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { User } from '@lucide/svelte';
	import { getUser } from '$lib/stores/auth.svelte';

	interface Props {
		collapsed?: boolean;
	}

	let { collapsed = false }: Props = $props();

	let avatarFailed = $state(false);

	const user = $derived(getUser());
	const primaryLabel = $derived(user?.githubLogin ?? user?.name ?? 'Account');
	const avatarUrl = $derived(user?.image ?? null);
	const isActive = $derived(page.url.pathname === '/settings');

	$effect(() => {
		// Reset failure state if URL rotates.
		avatarUrl;
		avatarFailed = false;
	});

	function handleClick(): void {
		void goto(isActive ? '/' : '/settings');
	}
</script>

<button
	class={collapsed ? 'user-trigger user-trigger--collapsed' : 'user-trigger'}
	class:user-trigger--active={isActive}
	onclick={handleClick}
	title={collapsed ? primaryLabel : undefined}
	aria-label={collapsed ? `${primaryLabel} — open settings` : undefined}
>
	{#if avatarUrl && !avatarFailed}
		<img
			src={avatarUrl}
			alt=""
			class={collapsed ? 'user-avatar user-avatar--collapsed' : 'user-avatar'}
			referrerpolicy="no-referrer"
			onerror={() => (avatarFailed = true)}
		/>
	{:else}
		<span
			class={collapsed
				? 'user-avatar user-avatar--collapsed user-avatar--fallback'
				: 'user-avatar user-avatar--fallback'}
			aria-hidden="true"
		>
			<User size={collapsed ? 12 : 14} />
		</span>
	{/if}

	{#if !collapsed}
		<span class="user-text">
			<span class="user-name">{primaryLabel}</span>
			{#if user?.email}
				<span class="user-email">{user.email}</span>
			{/if}
		</span>
	{/if}
</button>

<style>
	.user-trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		text-align: left;
		font-size: 11px;
		transition: background-color var(--duration-snap);
	}

	.user-trigger:hover {
		background: var(--color-bg-tertiary);
	}

	.user-trigger--active {
		background: var(--color-bg-elevated);
	}

	.user-trigger--collapsed {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		margin: 0 auto;
		border-radius: 5px;
	}

	.user-avatar {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.user-avatar--collapsed {
		width: 18px;
		height: 18px;
	}

	.user-avatar--fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
	}

	.user-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		flex: 1;
	}

	.user-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.user-email {
		font-size: 12px;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
