<script lang="ts">
	import { onMount } from 'svelte';
	import type { DotmatrixVariant } from '$lib/components/ui/dotmatrix';
	import { getIsAuthenticated, loadUser } from '$lib/stores/auth.svelte';
	import { getGithubHost, getSettings, fetchSettings } from '$lib/stores/settings.svelte';
	import { getRepositories, fetchRepos } from '$lib/stores/prs.svelte';
	import OnboardingShell from './OnboardingShell.svelte';
	import StepWelcome from './StepWelcome.svelte';
	import StepHost from './StepHost.svelte';
	import StepSignIn from './StepSignIn.svelte';
	import StepRepo from './StepRepo.svelte';
	import StepDone from './StepDone.svelte';

	type StepId = 'welcome' | 'host' | 'signin' | 'repo' | 'done';

	interface Props {
		/** Called once the user has fully completed onboarding. */
		onFinish: () => void;
	}

	let { onFinish }: Props = $props();

	const ORDER: StepId[] = ['welcome', 'host', 'signin', 'repo', 'done'];

	// Replay-mode flag set by `resetOnboarding()` in the auth store. When
	// present, we ignore the usual resume logic and force a start from
	// welcome so the user can experience the flow again even though their
	// host/auth/repos are already set. The flag is cleared once the user
	// reaches done (or unmounts) so a follow-up signout-and-back-in
	// doesn't accidentally bounce them back to welcome.
	const REPLAY_KEY = 'revv-onboarding-replay';
	const isReplay =
		typeof sessionStorage !== 'undefined' &&
		sessionStorage.getItem(REPLAY_KEY) === '1';

	// Resume point: derived from observable state so a mid-flow reload or
	// kill -9 lands the user on the right step without local persistence.
	let initialStep = $state<StepId>('welcome');
	let mounted = $state(false);

	onMount(async () => {
		// Make sure we have a settings snapshot before resolving the resume
		// point — getGithubHost() returns null until the store has data.
		if (!getSettings()) {
			await fetchSettings();
		}

		// Validate the stored token against the server before using it to
		// determine the resume step. A stale token (e.g. after a DB reset)
		// would cause getIsAuthenticated() to return true even though the
		// session is gone, skipping signin and then failing with 401 on
		// the repo step. loadUser() calls clearToken() internally when the
		// server rejects the session, so getIsAuthenticated() will return
		// false below if the token is no longer valid.
		await loadUser();

		// Refresh repo list before evaluating the resume point so stale
		// in-memory state doesn't cause the repo step to be skipped.
		if (getIsAuthenticated()) {
			await fetchRepos();
		}

		if (isReplay) {
			initialStep = 'welcome';
		} else {
			const host = getGithubHost();
			const authed = getIsAuthenticated();
			const repoCount = getRepositories().length;

			if (authed && repoCount > 0) {
				initialStep = 'done';
			} else if (authed) {
				initialStep = 'repo';
			} else if (host) {
				initialStep = 'signin';
			} else {
				initialStep = 'welcome';
			}
		}
		current = initialStep;
		mounted = true;
	});

	let current = $state<StepId>('welcome');
	let stepIndex = $derived(ORDER.indexOf(current));

	// Auto-advance: when authentication flips while on the signin step,
	// move forward to repo.
	$effect(() => {
		if (current === 'signin' && getIsAuthenticated()) {
			advance();
		}
	});

	function advance() {
		const idx = ORDER.indexOf(current);
		if (idx < 0 || idx >= ORDER.length - 1) return;
		const next = ORDER[idx + 1];
		if (next) current = next;
	}

	function goBack() {
		const idx = ORDER.indexOf(current);
		if (idx <= 0) return;
		let prev = ORDER[idx - 1];
		if (!prev) return;
		// signin is a one-way gate — skip it when going back while authenticated
		if (prev === 'signin' && getIsAuthenticated()) {
			prev = ORDER[ORDER.indexOf('signin') - 1];
			if (!prev) return;
		}
		current = prev;
	}

	interface StepMeta {
		chapter: string;
		title: string;
		titleItalic?: string;
		spinnerVariant: DotmatrixVariant;
	}

	const meta: Record<StepId, StepMeta> = {
		welcome: {
			chapter: 'Prologue',
			title: 'A slower way',
			titleItalic: 'to review code.',
			spinnerVariant: 'square-3',
		},
		host: {
			chapter: 'Chapter I · Origin',
			title: 'Where do your',
			titleItalic: 'repositories live?',
			spinnerVariant: 'square-13',
		},
		signin: {
			chapter: 'Chapter II · Key',
			title: 'Sign in to',
			titleItalic: 'GitHub.',
			spinnerVariant: 'square-2',
		},
		repo: {
			chapter: 'Chapter III · Archive',
			title: 'Choose a first',
			titleItalic: 'repository to read.',
			spinnerVariant: 'square-19',
		},
		done: {
			chapter: 'Fin',
			title: 'And now,',
			titleItalic: 'begin.',
			spinnerVariant: 'square-14',
		},
	};
</script>

{#if mounted}
	{@const m = meta[current]}
	<OnboardingShell
		stepId={current}
		stepIndex={stepIndex}
		totalSteps={ORDER.length}
		chapter={m.chapter}
		title={m.title}
		titleItalic={m.titleItalic}
		spinnerVariant={m.spinnerVariant}
	>
		{#key current}
			<div class="step-frame">
				{#if current === 'welcome'}
					<StepWelcome onContinue={advance} />
				{:else if current === 'host'}
					<StepHost onContinue={advance} onBack={goBack} />
				{:else if current === 'signin'}
					<StepSignIn onBack={goBack} />
				{:else if current === 'repo'}
					<StepRepo onContinue={advance} onBack={goBack} />
				{:else if current === 'done'}
					<StepDone onFinish={onFinish} />
				{/if}
			</div>
		{/key}
	</OnboardingShell>
{/if}

<style>
	.step-frame {
		animation: step-in 760ms cubic-bezier(0.16, 1, 0.3, 1) 280ms backwards;
	}

	@keyframes step-in {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.step-frame {
			animation: none;
		}
	}
</style>
