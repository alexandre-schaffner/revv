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

	let { children } = $props();
	let hydrated = false;

	// When user becomes authenticated (from any path — deep-link, polling,
	// or restored token), hydrate app data.  This single effect replaces
	// the previous per-path hydrate() calls so no auth path can miss it.
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

		// Listen for Tauri deep-link callbacks (rev://auth/callback?token=...)
		let cleanupDeepLink: (() => void) | undefined;
		if (isTauri()) {
			import('$lib/utils/deep-link').then(({ initDeepLinkListener }) => {
				initDeepLinkListener(async (token) => {
					auth.setToken(token);
					await auth.loadUser();
					// hydrate() is triggered by the reactive $effect above
					if (auth.getIsAuthenticated()) {
						try {
							const { getCurrentWindow } = await import('@tauri-apps/api/window');
							await getCurrentWindow().setFocus();
						} catch {
							// best-effort
						}
					}
				}).then((unlisten) => {
					cleanupDeepLink = unlisten;
				});
			});
		}

		// On mount: try to restore auth from localStorage.
		// If the token is valid, loadUser() sets the user, which triggers
		// the hydration effect above.
		auth.loadUser();
		// Fetch settings immediately — route is now public, no auth needed
		void settings.fetchSettings();

		return () => {
			cleanupTheme();
			cleanupShortcuts();
			cleanupDeepLink?.();
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

<AppShell>
	<ErrorBanner />
	{@render children()}
</AppShell>
