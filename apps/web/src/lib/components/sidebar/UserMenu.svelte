<script lang="ts">
import { githubHostLabel, sameGithubHost } from "@revv/shared";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import Check from "phosphor-svelte/lib/Check";
import Gear from "phosphor-svelte/lib/Gear";
import SignOut from "phosphor-svelte/lib/SignOut";
import Spinner from "phosphor-svelte/lib/Spinner";
import User from "phosphor-svelte/lib/User";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import Avatar from "$lib/components/shared/Avatar.svelte";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import { gsapFade, tokens } from "$lib/motion";
import { type AccountEntry, accountEntries } from "$lib/session/account-entries";
import { getSwitchingTo, signOut, switchSession } from "$lib/session/lifecycle.svelte";
import {
  getIsSwitching,
  getLocalAccounts,
  getUser,
  getWaitingReauths,
  openReauth,
} from "$lib/stores/auth.svelte";
import { getGithubHost } from "$lib/stores/settings.svelte";
import { openSettings } from "$lib/stores/settingsModal.svelte";

interface Props {
  collapsed?: boolean;
}

let { collapsed = false }: Props = $props();

let open = $state(false);

const user = $derived(getUser());
const entries = $derived(accountEntries(getLocalAccounts()));
const isSwitching = $derived(getIsSwitching());
const switchingTo = $derived(getSwitchingTo());

const displayAvatar = $derived(user?.image ?? null);
const waitingReauths = $derived(getWaitingReauths());

function needsReauth(entry: AccountEntry): boolean {
  return (
    entry.userId === user?.id && waitingReauths.some((a) => sameGithubHost(a.host, entry.host))
  );
}

function isEntryActive(entry: AccountEntry): boolean {
  return sameGithubHost(entry.host, getGithubHost()) && entry.githubLogin === user?.githubLogin;
}

async function handleSwitchEntry(entry: AccountEntry): Promise<void> {
  if (isEntryActive(entry) || isSwitching) return;
  await switchSession(entry.userId, entry.host);
  open = false;
}

function handleReauth(host: string): void {
  open = false;
  openReauth(host);
}

function handleSettings(): void {
  open = false;
  openSettings("general");
}

function handleSignOut(): void {
  open = false;
  void signOut();
}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger class={collapsed ? 'user-trigger user-trigger--collapsed' : 'user-trigger'}>
		<span class="user-avatar-wrap" class:user-avatar-wrap--switching={isSwitching}>
			<Avatar
				src={displayAvatar}
				size={28}
				fallback="user"
				glyphSize={collapsed ? 14 : 16}
				class="user-avatar"
			/>
			{#if isSwitching}
				<span class="user-avatar-spinner" aria-hidden="true">
					<Spinner size={collapsed ? 12 : 14} class="spin-icon motion-essential-spin" />
				</span>
			{:else if waitingReauths.length > 0}
				<span
					class="user-reauth-badge"
					title="An account needs to sign in again"
					in:gsapFade={{ duration: tokens.quick }}
				>
					<WarningCircle size={12} weight="fill" />
				</span>
			{/if}
		</span>
		<span class="user-text" class:user-text--gone={collapsed} aria-hidden={collapsed || undefined}>
			<span class="user-name">{user?.githubLogin ?? user?.name ?? 'Account'}</span>
			{#if user?.email}
				<span class="user-email">{user.email}</span>
			{/if}
		</span>
		<CaretDown size={12} class="user-caret{collapsed ? ' user-caret--gone' : ''}" />
	</PopoverTrigger>

	<PopoverContent
		class="w-64 p-1"
		align="start"
		side="top"
	>
		{#if waitingReauths.length > 0}
			{#each waitingReauths as account (account.host)}
				<button class="menu-row menu-row--warning" onclick={() => handleReauth(account.host)}>
					<WarningCircle size={13} weight="fill" class="menu-row-icon menu-row-icon--warning" />
					<span class="menu-row-label">Sign in again</span>
					<span class="menu-row-hint">{account.githubLogin ?? githubHostLabel(account.host)}</span>
				</button>
			{/each}
			<div class="menu-divider"></div>
		{/if}

		{#each entries as entry (entry.key)}
			{@const active = isEntryActive(entry)}
			{@const switching = switchingTo === entry.key}

			<button
				class="acct-row"
				class:acct-row--active={active}
				onclick={() => handleSwitchEntry(entry)}
				disabled={isSwitching}
				aria-pressed={active}
			>
				<span class="acct-avatar-wrap">
					<Avatar src={entry.avatarContent} size={18}>
						{#snippet fallback()}
							<User size={13} class="acct-icon" />
						{/snippet}
					</Avatar>
				</span>

				<span class="acct-body">
					<span class="acct-login">{entry.login}</span>
					<span class="acct-host">{entry.githubLogin ?? entry.email} · {entry.hostLabel}</span>
				</span>

				<span class="acct-status-slot">
					{#if switching}
						<Spinner size={12} class="acct-spinner motion-essential-spin" />
					{:else if needsReauth(entry)}
						<WarningCircle size={12} weight="fill" class="acct-warning" aria-label="Needs to sign in again" />
					{:else if active}
						<Check size={12} class="acct-check" />
					{/if}
				</span>
			</button>
		{/each}

		<div class="menu-divider"></div>

		<button class="menu-row" onclick={handleSettings}>
			<Gear size={13} class="menu-row-icon" />
			<span class="menu-row-label">Settings</span>
		</button>

		<button class="menu-row menu-row--danger" onclick={handleSignOut}>
			<SignOut size={13} class="menu-row-icon" />
			<span class="menu-row-label">Sign out</span>
		</button>
	</PopoverContent>
</PopoverRoot>

<style>
	:global(.user-trigger) {
		display: flex;
		align-items: center;
		gap: var(--spacing-island);
		width: 100%;
		padding: var(--spacing-island-half) var(--spacing-island);
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		text-align: left;
		font-size: 11px;
		overflow: hidden;
		transition:
			gap var(--duration-quick) var(--ease-out-expo),
			padding var(--duration-quick) var(--ease-out-expo);
	}

	:global(.user-trigger[data-state='open']) {
		background: var(--color-bg-elevated);
	}

	/* Centered through padding-left, not justify-content: justify-content
	   can't transition, so the avatar jumped sideways at the start of the
	   expand. (64 rail − 8 userbar padding − 28 avatar) / 2 = 14px. */
	:global(.user-trigger--collapsed) {
		padding: 0 14px;
		gap: 0;
	}

	.user-avatar-wrap {
		position: relative;
		flex-shrink: 0;
		display: inline-flex;
	}

	.user-avatar-wrap--switching :global(.user-avatar) {
		opacity: 0.4;
	}

	.user-reauth-badge {
		position: absolute;
		right: -3px;
		bottom: -3px;
		display: flex;
		border-radius: 999px;
		background: var(--color-bg-secondary);
		color: var(--color-warning);
	}

	.user-avatar-spinner {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	:global(.spin-icon) {
		color: var(--color-text-muted);
	}

	.user-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		flex: 1;
		overflow: hidden;
		max-width: 300px; /* ceiling for collapse transition */
		transition:
			opacity var(--duration-quick) var(--ease-out-expo) 60ms,
			max-width var(--duration-quick) var(--ease-out-expo) 60ms,
			visibility 0s linear 0s;
	}

	.user-text--gone {
		opacity: 0;
		visibility: hidden;
		max-width: 0;
		pointer-events: none;
		transition:
			opacity var(--duration-quick) var(--ease-soft),
			max-width var(--duration-quick) var(--ease-soft),
			visibility 0s linear var(--duration-quick);
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

	:global(.user-caret) {
		flex-shrink: 0;
		color: var(--color-text-muted);
		overflow: hidden;
		max-width: 20px;
		transition:
			opacity var(--duration-quick) var(--ease-out-expo) 60ms,
			max-width var(--duration-quick) var(--ease-out-expo) 60ms,
			visibility 0s linear 0s;
	}

	:global(.user-caret--gone) {
		opacity: 0;
		visibility: hidden;
		max-width: 0;
		transition:
			opacity var(--duration-quick) var(--ease-soft),
			max-width var(--duration-quick) var(--ease-soft),
			visibility 0s linear var(--duration-quick);
	}

	.acct-row {
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

	.acct-row:hover:not(:disabled) {
		background: var(--color-bg-tertiary);
	}

	.acct-row--active {
		background: var(--color-bg-tertiary);
		cursor: default;
	}

	.acct-row:disabled {
		cursor: default;
	}

	.acct-avatar-wrap {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
	}

	:global(.acct-icon) {
		color: var(--color-text-muted);
	}

	.acct-body {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
		min-width: 0;
	}

	.acct-login {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.acct-host {
		font-size: 10px;
		color: var(--color-text-muted);
	}

	.acct-status-slot {
		flex-shrink: 0;
		width: 16px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	:global(.acct-check) {
		color: var(--color-accent);
	}

	:global(.acct-warning) {
		color: var(--color-warning);
	}

	:global(.acct-spinner) {
		color: var(--color-text-muted);
	}

	.menu-divider {
		height: 1px;
		margin: 4px 6px;
		background: var(--color-border);
	}

	:global(.menu-row) {
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
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	:global(.menu-row:hover) {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	:global(.menu-row--danger:hover) {
		color: var(--color-danger);
	}

	:global(.menu-row:hover .menu-row-icon) {
		color: var(--color-text-secondary);
	}

	:global(.menu-row-icon) {
		flex-shrink: 0;
		color: var(--color-text-muted);
		transition: color var(--duration-snap);
	}

	:global(.menu-row-label) {
		flex: 1;
	}

	:global(.menu-row-icon--warning),
	:global(.menu-row--warning:hover .menu-row-icon--warning) {
		color: var(--color-warning);
	}

	.menu-row-hint {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10px;
		color: var(--color-text-muted);
	}

</style>
