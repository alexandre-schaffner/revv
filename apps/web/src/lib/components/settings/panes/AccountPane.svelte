<script lang="ts">
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import Spinner from "phosphor-svelte/lib/Spinner";
import User from "phosphor-svelte/lib/User";
import Warning from "phosphor-svelte/lib/Warning";
import SignInButton from "$lib/components/auth/SignInButton.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { getUser, removeAccount, signOut } from "$lib/stores/auth.svelte";
import { getGithubHost } from "$lib/stores/settings.svelte";
import { closeSettings } from "$lib/stores/settingsModal.svelte";
import SettingsGroup from "../primitives/SettingsGroup.svelte";
import SettingsPane from "../primitives/SettingsPane.svelte";
import SettingsRow from "../primitives/SettingsRow.svelte";
import { SETTINGS_PANES } from "../settings-index";

const user = $derived(getUser());
const host = $derived(getGithubHost() ?? "github.com");

// URL-keyed: failed state is only true while the current URL is the one that
// errored. If the URL rotates (e.g. after re-login), the new URL is retried.
let avatarFailedForUrl = $state<string | null>(null);
const avatarFailed = $derived(
  avatarFailedForUrl !== null && avatarFailedForUrl === (user?.image ?? null),
);

let showDeleteConfirm = $state(false);
let deleting = $state(false);
let deleteError = $state<string | null>(null);

async function handleRemoveAccount(): Promise<void> {
  deleting = true;
  deleteError = null;
  try {
    await removeAccount();
    closeSettings();
  } catch (e) {
    deleteError = e instanceof Error ? e.message : "Failed to remove account. Please try again.";
  } finally {
    deleting = false;
  }
}
</script>

<SettingsPane {...SETTINGS_PANES.account}>
	{#if user}
		<SettingsGroup>
			<SettingsRow id="account-identity" label={user.name}>
				{#snippet leading()}
					{#if user.image && !avatarFailed}
						<img
							src={user.image}
							alt=""
							class="identity-avatar"
							referrerpolicy="no-referrer"
							onerror={() => (avatarFailedForUrl = user?.image ?? null)}
						/>
					{:else}
						<span class="identity-avatar identity-avatar--fallback" aria-hidden="true">
							<User size={16} />
						</span>
					{/if}
				{/snippet}
				{#snippet hint()}
					<span class="identity-meta">
						{#if user.githubLogin}
							<span>@{user.githubLogin}</span>
						{/if}
						{#if user.email}
							<span class="identity-email">{user.email}</span>
						{/if}
						<span class="identity-host" title="GitHub host">{host}</span>
					</span>
				{/snippet}
				{#snippet control()}
					<Button variant="outline" size="sm" onclick={signOut}>Sign out</Button>
				{/snippet}
			</SettingsRow>
			<SettingsRow
				id="account-revoke"
				label="Revoke access on GitHub"
				hint="Signing out clears Revv's local copy of your token. To revoke Revv's access on GitHub's side, remove it from your authorized applications."
			>
				{#snippet control()}
					<Button
						variant="outline"
						size="sm"
						href="https://{host}/settings/applications"
						target="_blank"
						rel="noopener noreferrer"
					>
						Open GitHub
						<ArrowSquareOut size={12} />
					</Button>
				{/snippet}
			</SettingsRow>
		</SettingsGroup>

		<SettingsGroup heading="Remove account" tone="danger">
			<SettingsRow
				id="account-remove"
				label="Remove this account"
				hint="Permanently deletes the account and all of its local data. This cannot be undone."
			>
				{#snippet control()}
					{#if !showDeleteConfirm}
						<Button variant="destructive" size="sm" onclick={() => (showDeleteConfirm = true)}>
							Remove account…
						</Button>
					{:else}
						<Button
							variant="ghost"
							size="sm"
							onclick={() => (showDeleteConfirm = false)}
							disabled={deleting}
						>
							Cancel
						</Button>
						<Button variant="destructive" size="sm" onclick={handleRemoveAccount} disabled={deleting}>
							{#if deleting}
								<Spinner size={12} class="motion-essential-spin" />
								Removing…
							{:else}
								<Warning size={12} weight="fill" />
								Confirm remove
							{/if}
						</Button>
					{/if}
				{/snippet}
				{#if deleteError}
					<p class="delete-error" role="alert">{deleteError}</p>
				{/if}
			</SettingsRow>
		</SettingsGroup>
	{:else}
		<SettingsGroup>
			<SettingsRow
				id="account-identity"
				label="Not signed in"
				hint="Sign in with GitHub to sync your repositories and pull requests."
			>
				{#snippet control()}
					<SignInButton />
				{/snippet}
			</SettingsRow>
		</SettingsGroup>
	{/if}
</SettingsPane>

<style>
	.identity-avatar {
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		border-radius: 50%;
		object-fit: cover;
	}

	.identity-avatar--fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.identity-meta {
		display: inline-flex;
		min-width: 0;
		flex-wrap: wrap;
		align-items: center;
		column-gap: 8px;
		row-gap: 2px;
	}

	.identity-email {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.identity-host {
		padding: 1px 6px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 4px;
		background: var(--color-bg-secondary);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 11px;
		color: var(--color-text-secondary);
	}

	.delete-error {
		font-size: 12px;
		color: var(--color-danger);
	}
</style>
