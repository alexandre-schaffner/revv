<script lang="ts">
import type { Snippet } from "svelte";
import { gsapFade, tokens } from "$lib/motion";
import {
  getAccountJustRemoved,
  getForceOnboardingFlow,
  getIsAuthenticated,
  getIsOnboarded,
  getLocalAccounts,
  getToken,
  getUser,
  resetForceOnboardingFlow,
} from "$lib/stores/auth.svelte";
import AccountPicker from "./AccountPicker.svelte";
import OnboardingFlow from "./OnboardingFlow.svelte";

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

// During a fresh page load with a stored token but no user payload yet,
// `authed` is true but `onboarded` is false because the identity request
// hasn't returned. Showing onboarding in that window would flash the
// welcome screen for an already-onboarded user. Hold the gate's decision
// until either the user payload lands OR we can confirm there's no token.
const ready = $derived(getToken() === null || hasUser);

let showApp = $derived(authed && onboarded);
const forceFlow = $derived(getForceOnboardingFlow());
// Show the account picker when: not authenticated, but local accounts exist on this machine
// Suppress picker when the account was just removed or force flag is set — fall through to OnboardingFlow instead
let showPicker = $derived(
  !authed && localAccounts.length > 0 && !getAccountJustRemoved() && !forceFlow,
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

{#if ready}
	{#if showApp}
		<div class="root" in:gsapFade={{ duration: tokens.slow }}>
			{@render children()}
		</div>
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
</style>
