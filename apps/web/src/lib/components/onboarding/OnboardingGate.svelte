<script lang="ts">
	import type { Snippet } from 'svelte';
	import { softFade } from '$lib/motion';
	import { getIsAuthenticated, getIsOnboarded, getUser, getToken } from '$lib/stores/auth.svelte';
	import OnboardingFlow from './OnboardingFlow.svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	/**
	 * Gate decides which of two roots renders:
	 *   - OnboardingFlow when the user is not yet through the 5-step flow
	 *   - The app shell ({@render children()}) once they're authenticated
	 *     AND have `onboardedAt` set on their user row.
	 *
	 * "Onboarded" is the stronger signal: a user can be authenticated
	 * (i.e. has a session token) but never finished picking a repo if they
	 * killed the app mid-flow. The DB column is the durable source of truth.
	 *
	 * StepDone defers the call to `completeOnboarding()` until after the
	 * success animation plays, so the optimistic local mutation that flips
	 * `onboarded` to true coincides with the visual moment the gate should
	 * actually swap. No "forceShow" override needed.
	 */
	const authed = $derived(getIsAuthenticated());
	const onboarded = $derived(getIsOnboarded());
	const hasUser = $derived(getUser() !== null);

	// During a fresh page load with a stored token but no user payload yet,
	// `authed` is true but `onboarded` is false because the identity request
	// hasn't returned. Showing onboarding in that window would flash the
	// welcome screen for an already-onboarded user. Hold the gate's decision
	// until either the user payload lands OR we can confirm there's no token.
	const ready = $derived(getToken() === null || hasUser);

	function handleFinish() {
		// StepDone has already kicked the local `onboardedAt` flip; the
		// `showApp` derivation handles the swap. Nothing else to do here
		// — the prop is kept for future hooks (analytics, telemetry).
	}

	let showApp = $derived(authed && onboarded);
</script>

{#if ready}
	{#if showApp}
		<div class="root" in:softFade={{ duration: 320 }}>
			{@render children()}
		</div>
	{:else}
		<div out:softFade={{ duration: 220 }}>
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
