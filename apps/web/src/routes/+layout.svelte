<script lang="ts">
	import '../app.css';
	import AppShell from '$lib/components/layout/AppShell.svelte';
	import ErrorBanner from '$lib/components/shared/ErrorBanner.svelte';
	import * as auth from '$lib/stores/auth.svelte';
	import * as prs from '$lib/stores/prs.svelte';
	import * as settings from '$lib/stores/settings.svelte';
	import * as sync from '$lib/services/sync';
	import { initTheme } from '$lib/stores/theme.svelte';
	import { initShortcuts } from '$lib/stores/shortcuts.svelte';
	import { TooltipProvider } from '$lib/components/ui/tooltip';
	import { Toaster } from '$lib/components/ui/sonner';
	import CacheInspector from '$lib/components/dev/CacheInspector.svelte';

	let { children } = $props();
	let hydrated = false;
	let cacheInspectorOpen = $state(false);

	$effect(() => {
		function handleKeydown(e: KeyboardEvent): void {
			if (import.meta.env.DEV && e.metaKey && e.shiftKey && e.key === 'C') {
				e.preventDefault();
				cacheInspectorOpen = !cacheInspectorOpen;
			}
		}
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});

	// When user becomes authenticated, hydrate app data.
	$effect(() => {
		const user = auth.getUser();
		if (user && !hydrated) {
			hydrated = true;
			hydrate();
		}
		if (!user) {
			hydrated = false;
		}
	});

	$effect(() => {
		const cleanupTheme = initTheme();
		const cleanupShortcuts = initShortcuts();

		// On mount: try to restore auth from localStorage.
		// If the token is valid, loadUser() sets the user, which triggers
		// the hydration effect above.
		auth.loadUser();
		// Fetch settings immediately — route is now public, no auth needed
		void settings.fetchSettings();
		// Prefetch both agents' model lists so agent/model dropdowns can
		// swap instantly without a round-trip (and without a race between
		// the PUT that changes the agent and the GET that lists models).
		void settings.fetchAllModels();

		return () => {
			cleanupTheme();
			cleanupShortcuts();
			sync.stopPolling();
		};
	});

	async function hydrate() {
		// Load cached data first (instant UI)
		await Promise.all([prs.fetchPrs(), prs.fetchRepos(), settings.fetchSettings()]);

		// Then kick off a live sync from GitHub
		const token = auth.getToken();
		if (!token) return;

		const s = settings.getSettings();
		const interval = s?.autoFetchInterval ?? 5;
		sync.startPolling(interval, token);
	}
</script>

<TooltipProvider>
	<AppShell>
		<ErrorBanner />
		{@render children()}
	</AppShell>
	<Toaster />
	{#if import.meta.env.DEV && cacheInspectorOpen}
		<CacheInspector onclose={() => { cacheInspectorOpen = false; }} />
	{/if}
</TooltipProvider>
