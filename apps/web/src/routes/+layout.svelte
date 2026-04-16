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
	import { isTauri } from '$lib/utils/platform';
	import { TooltipProvider } from '$lib/components/ui/tooltip';

	let { children } = $props();
	let hydrated = false;

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
</TooltipProvider>
