<script lang="ts">
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import Spinner from "phosphor-svelte/lib/Spinner";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import type { Snippet } from "svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { gsapFade, tokens } from "$lib/motion";
import {
  clearToken,
  getAccountJustRemoved,
  getAuthRestoreError,
  getAuthRestoreExhausted,
  getAuthRestoreMaxRetries,
  getAuthRestoreRetryAttempts,
  getForceOnboardingFlow,
  getIsAuthenticated,
  getIsOnboarded,
  getLocalAccounts,
  getLocalAccountsLoaded,
  getToken,
  getUser,
  resetForceOnboardingFlow,
  retryAuthRestore,
} from "$lib/stores/auth.svelte";
import ReauthModal from "../auth/ReauthModal.svelte";
import AccountPicker from "./AccountPicker.svelte";
import OnboardingFlow from "./OnboardingFlow.svelte";
import RevvBrand from "./RevvBrand.svelte";

interface Props {
  children: Snippet;
}

let { children }: Props = $props();

/**
 * Gate decides which of three roots renders:
 *   - The app shell ({@render children()}) once authenticated and onboarded
 *   - AccountPicker when not authenticated but local accounts exist (lock screen)
 *   - OnboardingFlow for first-time sign-in or when picker is dismissed
 *
 * "Onboarded" is the durable signal: a user can be authenticated
 * (i.e. has a session token) but never finished picking a repo if they
 * killed the app mid-flow. The DB column is the source of truth.
 */
const authed = $derived(getIsAuthenticated());
const onboarded = $derived(getIsOnboarded());
const hasUser = $derived(getUser() !== null);
const localAccounts = $derived(getLocalAccounts());
const localAccountsLoaded = $derived(getLocalAccountsLoaded());
const hasLocalConnectedAccount = $derived(localAccounts.some((la) => la.accounts.length > 0));
const restoringSession = $derived(getToken() !== null && !hasUser);
const restoreError = $derived(getAuthRestoreError());
const restoreExhausted = $derived(getAuthRestoreExhausted());
const restoreRetryAttempts = $derived(getAuthRestoreRetryAttempts());
const restoreMaxRetries = $derived(getAuthRestoreMaxRetries());

// During a fresh page load with a stored token but no user payload yet,
// `authed` is true but `onboarded` is false because the identity request
// hasn't returned. Showing onboarding in that window would flash the
// welcome screen for an already-onboarded user. Hold the gate's decision
// until either the user payload lands OR, for signed-out boots, local
// account detection has resolved so returning users go straight to picker.
const ready = $derived(getToken() === null ? localAccountsLoaded : hasUser);

let showApp = $derived(authed && onboarded);
const forceFlow = $derived(getForceOnboardingFlow());
// Show the account picker when: not authenticated, but local accounts exist on this machine
// Suppress picker when the account was just removed or force flag is set — fall through to OnboardingFlow instead
let showPicker = $derived(
  !authed && hasLocalConnectedAccount && !getAccountJustRemoved() && !forceFlow,
);

// User can dismiss the picker to reach the full onboarding flow
// (e.g., to sign in with a new account)
let pickerDismissed = $state(false);

// Reset dismissal and force-flow flag when auth state changes (user signed in successfully)
$effect(() => {
  if (authed) {
    pickerDismissed = false;
    resetForceOnboardingFlow();
  }
});

function handleFinish() {
  // StepDone has already kicked the local `onboardedAt` flip
}

function handleNewAccount() {
  pickerDismissed = true;
}
</script>

{#if !ready && restoringSession}
	<div class="restore-root" in:gsapFade={{ duration: tokens.smooth }}>
		<div class="restore-rail" aria-hidden="true">
			<div class="restore-rail-mark"></div>
			<div class="restore-rail-dot"></div>
			<div class="restore-rail-dot"></div>
			<div class="restore-rail-dot restore-rail-dot-muted"></div>
		</div>
		<div class="restore-sidebar" aria-hidden="true">
			<div class="restore-sidebar-top">
				<RevvBrand />
				<div class="restore-skeleton restore-skeleton-button"></div>
			</div>
			<div class="restore-sidebar-list">
				{#each Array.from({ length: 6 }) as _, index}
					<div class="restore-sidebar-row">
						<div class="restore-skeleton restore-skeleton-avatar"></div>
						<div class="restore-sidebar-row-copy">
							<div class="restore-skeleton restore-skeleton-line" style={`--w: ${index % 2 ? 74 : 88}%`}></div>
							<div class="restore-skeleton restore-skeleton-line restore-skeleton-line-sm" style={`--w: ${index % 3 ? 48 : 62}%`}></div>
						</div>
					</div>
				{/each}
			</div>
		</div>
		<div class="restore-main">
			<div class="restore-main-content">
				<RevvBrand class="restore-brand-mobile" aria-hidden="true" />
				<div class="restore-status">
					<img src="/icon.svg" alt="" class="restore-status-watermark" aria-hidden="true" />
					<div class="restore-status-icon" class:restore-status-icon-error={restoreExhausted}>
						{#if restoreExhausted}
							<WarningCircle size={22} weight="duotone" />
						{:else}
							<Spinner size={18} weight="bold" class="motion-essential-spin" />
						{/if}
					</div>
					<div class="restore-copy">
						<h1>{restoreExhausted ? "Revv server unavailable" : "Opening Revv"}</h1>
						<p>
							{#if restoreExhausted}
								{restoreError ?? "The local Revv server did not respond."}
							{:else if restoreError}
								Retrying connection ({restoreRetryAttempts}/{restoreMaxRetries})…
							{:else}
								Connecting to the local Revv server…
							{/if}
						</p>
					</div>
					{#if restoreExhausted}
						<div class="restore-actions">
							<Button size="sm" onclick={retryAuthRestore}>
								<ArrowsClockwise data-icon="inline-start" />
								Retry
							</Button>
							<Button variant="outline" size="sm" onclick={clearToken}>Use another account</Button>
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{:else if ready}
	{#if showApp}
		<div class="root" in:gsapFade={{ duration: tokens.slow }}>
			{@render children()}
		</div>
		<!-- Blocking re-auth gate: overlays the app (kept mounted) when the
		     active account's GitHub token expired and couldn't be refreshed. -->
		<ReauthModal />
	{:else if showPicker && !pickerDismissed}
		<AccountPicker onNewAccount={handleNewAccount} />
	{:else}
		<div out:gsapFade={{ duration: tokens.smooth }}>
			<OnboardingFlow onFinish={handleFinish} />
		</div>
	{/if}
{/if}

<style>
	.root {
		height: 100%;
		width: 100%;
	}

	.restore-root {
		background: var(--color-bg-primary);
		color: var(--color-text-primary);
		display: grid;
		grid-template-columns: 54px minmax(240px, 320px) minmax(0, 1fr);
		height: 100%;
		overflow: hidden;
		width: 100%;
	}

	.restore-rail {
		align-items: center;
		background: var(--color-bg-secondary);
		border-right: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px 8px;
	}

	.restore-rail-mark,
	.restore-rail-dot {
		background: var(--color-glass-active-bg);
		border: 1px solid var(--color-glass-border);
		border-radius: 8px;
		height: 32px;
		width: 32px;
	}

	.restore-rail-mark {
		background: color-mix(in srgb, var(--color-accent) 16%, var(--color-bg-elevated));
		border-color: color-mix(in srgb, var(--color-accent) 26%, var(--color-border));
		margin-bottom: 10px;
	}

	.restore-rail-dot {
		border-radius: 999px;
		height: 28px;
		width: 28px;
	}

	.restore-rail-dot-muted {
		margin-top: auto;
	}

	.restore-sidebar {
		background: var(--color-bg-secondary);
		border-right: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: 12px 10px;
	}

	.restore-sidebar-top {
		align-items: center;
		display: flex;
		gap: 10px;
		height: 40px;
		justify-content: space-between;
		padding: 0 4px 10px;
	}

	:global(.restore-brand-mobile) {
		display: none;
	}

	.restore-sidebar-list {
		display: grid;
		gap: 4px;
		padding-top: 4px;
	}

	.restore-sidebar-row {
		align-items: center;
		border-radius: 8px;
		display: flex;
		gap: 10px;
		padding: 8px 7px;
	}

	.restore-sidebar-row:first-child {
		background: var(--color-glass-active-bg);
	}

	.restore-sidebar-row-copy {
		display: grid;
		flex: 1;
		gap: 6px;
		min-width: 0;
	}

	.restore-skeleton {
		background: var(--color-glass-active-bg);
		border-radius: 6px;
	}

	.restore-skeleton-button {
		height: 24px;
		width: 56px;
	}

	.restore-skeleton-avatar {
		border-radius: 999px;
		height: 28px;
		width: 28px;
	}

	.restore-skeleton-line {
		height: 8px;
		width: var(--w, 80%);
	}

	.restore-skeleton-line-sm {
		height: 7px;
		opacity: 0.65;
	}

	.restore-main {
		align-items: center;
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--color-bg-primary) 85%, transparent), var(--color-bg-primary)),
			var(--color-bg-primary);
		display: flex;
		justify-content: center;
		min-width: 0;
		padding: 32px;
	}

	.restore-main-content {
		display: grid;
		gap: 14px;
		width: min(100%, 440px);
	}

	.restore-status {
		align-items: flex-start;
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		box-shadow: var(--color-shadow-lg);
		display: grid;
		gap: 14px;
		grid-template-columns: auto minmax(0, 1fr);
		max-width: 440px;
		overflow: hidden;
		padding: 18px;
		position: relative;
		width: 100%;
	}

	.restore-status-watermark {
		height: 148px;
		opacity: 0.045;
		pointer-events: none;
		position: absolute;
		right: -18px;
		top: 50%;
		transform: translateY(-50%);
		width: 148px;
		z-index: 0;
	}

	.restore-status-icon {
		align-items: center;
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-accent) 25%, transparent);
		border-radius: 8px;
		color: var(--color-accent);
		display: flex;
		height: 36px;
		justify-content: center;
		position: relative;
		width: 36px;
		z-index: 1;
	}

	.restore-status-icon-error {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		border-color: color-mix(in srgb, var(--color-danger) 25%, transparent);
		color: var(--color-danger);
	}

	.restore-copy {
		display: grid;
		gap: 8px;
		position: relative;
		z-index: 1;
	}

	.restore-copy h1 {
		font-size: 14px;
		font-weight: 620;
		line-height: 1.2;
		margin: 0;
	}

	.restore-copy p {
		color: var(--color-text-secondary);
		font-size: 12px;
		line-height: 1.5;
		margin: 0;
	}

	.restore-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		grid-column: 2;
		position: relative;
		z-index: 1;
	}

	@media (max-width: 720px) {
		.restore-root {
			grid-template-columns: 1fr;
		}

		.restore-rail,
		.restore-sidebar {
			display: none;
		}

		.restore-main {
			padding: 20px;
		}

		:global(.restore-brand-mobile) {
			display: inline-flex;
			justify-self: start;
			padding-left: 2px;
		}

		.restore-status {
			grid-template-columns: auto minmax(0, 1fr);
			padding: 16px;
		}

		.restore-status-watermark {
			height: 120px;
			right: -24px;
			width: 120px;
		}
	}
</style>
