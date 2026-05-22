<script lang="ts">
import Check from "phosphor-svelte/lib/Check";
import ChevronDown from "phosphor-svelte/lib/CaretDown";
import Loader2 from "phosphor-svelte/lib/Spinner";
import LogOut from "phosphor-svelte/lib/SignOut";
import Settings from "phosphor-svelte/lib/Gear";
import User from "phosphor-svelte/lib/User";
import {
  Content as PopoverContent,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "$lib/components/ui/popover/index.js";
import {
  getIsSwitching,
  getLocalAccounts,
  getUser,
  signOut,
  switchAccount,
} from "$lib/stores/auth.svelte";
import { getGithubHost } from "$lib/stores/settings.svelte";
import { toggleSettings } from "$lib/stores/settingsModal.svelte";

interface Props {
  collapsed?: boolean;
}

let { collapsed = false }: Props = $props();

type SwitcherEntry = {
  userId: string;
  host: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  userImage: string | null;
  userName: string;
  userEmail: string;
};

let open = $state(false);
let _lastAvatar = $state<string | null>(null);
let _avatarFailedForUrl = $state<string | null>(null);
let _acctAvatarFailedUrls = $state(new Set<string>());
let switchingId = $state<string | null>(null);

const user = $derived(getUser());
const localAccounts = $derived(getLocalAccounts());
const isSwitching = $derived(getIsSwitching());

const displayAvatar = $derived(user?.image ?? null);

// avatarFailed is true only when the current URL has previously errored
const avatarFailed = $derived(_avatarFailedForUrl === displayAvatar && displayAvatar !== null);

// When isSwitching drops to false, clear the per-row switching tracker
const _switchingActive = $derived(isSwitching ? switchingId : null);

// Flat list of (userId, host) entries — one row per connected host per user
const switcherEntries = $derived(
  localAccounts.flatMap((la) =>
    la.accounts.map((acct) => ({
      userId: la.id,
      host: acct.host,
      githubLogin: acct.githubLogin,
      avatarUrl: acct.avatarUrl,
      userImage: la.image,
      userName: la.name,
      userEmail: la.email,
    })),
  ),
);

function hostLabel(host: string): string {
  if (host === "github.com") return "GitHub";
  return host;
}

function isEntryActive(entry: SwitcherEntry): boolean {
  const currentHost = getGithubHost();
  return entry.host === currentHost && entry.githubLogin === user?.githubLogin;
}

function entryKey(entry: SwitcherEntry): string {
  return `${entry.userId}:${entry.host}`;
}

async function handleSwitchEntry(entry: SwitcherEntry): Promise<void> {
  if (isEntryActive(entry) || isSwitching) return;
  switchingId = entryKey(entry);
  try {
    await switchAccount(entry.userId, entry.host);
    open = false;
  } finally {
    switchingId = null;
  }
}

function handleSettings(): void {
  open = false;
  toggleSettings();
}

async function handleSignOut(): Promise<void> {
  open = false;
  try {
    await signOut();
  } catch {
    // Best-effort — the UI will reflect auth state regardless
  }
}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger class={collapsed ? 'user-trigger user-trigger--collapsed' : 'user-trigger'}>
		<span class="user-avatar-wrap" class:user-avatar-wrap--switching={isSwitching}>
			{#if displayAvatar && !avatarFailed}
				<img
					src={displayAvatar}
					alt=""
					class={collapsed ? 'user-avatar user-avatar--collapsed' : 'user-avatar'}
					referrerpolicy="no-referrer"
					onerror={() => (_avatarFailedForUrl = displayAvatar)}
				/>
			{:else}
				<span
					class={collapsed
						? 'user-avatar user-avatar--collapsed user-avatar--fallback'
						: 'user-avatar user-avatar--fallback'}
					aria-hidden="true"
				>
					<User size={collapsed ? 14 : 16} weight="regular" />
				</span>
			{/if}
			{#if isSwitching}
				<span class="user-avatar-spinner" aria-hidden="true">
					<Loader2 size={collapsed ? 12 : 14} weight="regular" class="spin-icon" />
				</span>
			{/if}
		</span>
		<span class="user-text" class:user-text--gone={collapsed} aria-hidden={collapsed || undefined}>
			<span class="user-name">{user?.githubLogin ?? user?.name ?? 'Account'}</span>
			{#if user?.email}
				<span class="user-email">{user.email}</span>
			{/if}
		</span>
		<ChevronDown size={12} class="user-caret{collapsed ? ' user-caret--gone' : ''}" />
	</PopoverTrigger>

	<PopoverContent
		class={collapsed ? 'w-64 p-1' : 'p-1'}
		style={collapsed ? undefined : 'width: var(--bits-popover-anchor-width)'}
		align="start"
		side="top"
	>
		<!-- Account rows -->
		{#each switcherEntries as entry (entryKey(entry))}
			{@const active = isEntryActive(entry)}
			{@const switching = _switchingActive === entryKey(entry)}
			{@const avatar = entry.avatarUrl ?? entry.userImage}

			<button
				class="acct-row"
				class:acct-row--active={active}
				onclick={() => handleSwitchEntry(entry)}
				disabled={isSwitching}
				aria-pressed={active}
			>
				<!-- Avatar -->
				<span class="acct-avatar-wrap">
					{#if avatar && !_acctAvatarFailedUrls.has(avatar)}
						<img
							src={avatar}
							alt=""
							class="acct-avatar"
							referrerpolicy="no-referrer"
							onerror={() => { _acctAvatarFailedUrls = new Set([..._acctAvatarFailedUrls, avatar]); }}
						/>
					{:else}
						<User size={13} weight="regular" class="acct-icon" />
					{/if}
				</span>

				<!-- Identity -->
				<span class="acct-body">
					<span class="acct-login">{entry.githubLogin ?? entry.userName}</span>
					<span class="acct-host">{entry.githubLogin ?? entry.userEmail} · {hostLabel(entry.host)}</span>
				</span>

				<!-- Status indicator -->
				<span class="acct-status-slot">
					{#if switching}
						<Loader2 size={12} weight="regular" class="acct-spinner" />
					{:else if active}
						<Check size={12} weight="regular" class="acct-check" />
					{/if}
				</span>
			</button>
		{/each}

		<div class="menu-divider"></div>

		<!-- Settings -->
		<button class="menu-row" onclick={handleSettings}>
			<Settings size={13} weight="fill" class="menu-row-icon" />
			<span class="menu-row-label">Settings</span>
		</button>

		<!-- Sign out -->
		<button class="menu-row menu-row--danger" onclick={handleSignOut}>
			<LogOut size={13} class="menu-row-icon" />
			<span class="menu-row-label">Sign out</span>
		</button>
	</PopoverContent>
</PopoverRoot>

<style>
	/* ── Trigger ──
	   Lives inside the userbar chrome strip (AppShell .userbar-area). The
	   trigger fills the bar width; padding/gap come from island tokens so
	   the chip-on-chrome rhythm matches .acct-row / .menu-row below. The
	   collapsed variant centers the 28px avatar inside the rail's
	   effective width (RAIL_WIDTH − userbar's chrome-gap padding-left). */
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

	/* Collapsed: only the rail column is visible. Centering the avatar via
	   padding-left rather than justify-content keeps the motion continuous
	   when toggling — justify-content can't be transitioned, so swapping
	   it caused the avatar to jump sideways at the start of the expand
	   animation before easing back. padding-left is part of the trigger's
	   transition list, so it animates with the rest of the geometry.
	   Value = (RAIL_WIDTH − userbar padding-left − avatar size) / 2
	         = (64 − 8 − 28) / 2 = 14px. */
	:global(.user-trigger--collapsed) {
		padding: 0 14px;
		gap: 0;
	}

	/* ── Trigger avatar with spinner overlay ── */
	.user-avatar-wrap {
		position: relative;
		flex-shrink: 0;
		display: inline-flex;
	}

	.user-avatar-wrap--switching .user-avatar {
		opacity: 0.4;
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
		animation: spin 1s linear infinite;
	}

	.user-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.user-avatar--collapsed {
		/* No size change — parent shrink handles the visual effect */
	}

	.user-avatar--fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
		border-radius: 50%;
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

	/* Collapse direction — text fades + collapses out first, ahead of the column */
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

	/* ── Account rows ── */
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

	.acct-avatar {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		object-fit: cover;
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

	:global(.acct-spinner) {
		color: var(--color-text-muted);
		animation: spin 1s linear infinite;
	}

	/* ── Divider ── */
	.menu-divider {
		height: 1px;
		margin: 4px 6px;
		background: var(--color-border);
	}

	/* ── Menu rows (Add account, Settings, Sign out) ── */
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

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
