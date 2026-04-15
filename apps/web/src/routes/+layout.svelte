<script lang="ts">
	import '../app.css';
	import AppShell from '$lib/components/layout/AppShell.svelte';
	import AuthGuard from '$lib/components/auth/AuthGuard.svelte';
	import ErrorBanner from '$lib/components/shared/ErrorBanner.svelte';
	import * as auth from '$lib/stores/auth.svelte';
	import * as prs from '$lib/stores/prs.svelte';
	import * as settings from '$lib/stores/settings.svelte';
	import * as sync from '$lib/services/sync';
	import { initTheme } from '$lib/stores/theme.svelte';
	import { initShortcuts } from '$lib/stores/shortcuts.svelte';
	import { isTauri } from '$lib/utils/platform';

	let { children } = $props();

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
					if (auth.getIsAuthenticated()) {
						// Focus the Tauri window so the user returns to the app
						try {
							const { getCurrentWindow } = await import('@tauri-apps/api/window');
							await getCurrentWindow().setFocus();
						} catch {
							// best-effort
						}
						hydrate();
					}
				}).then((unlisten) => {
					cleanupDeepLink = unlisten;
				});
			});
		}

		// On mount: try to restore auth from localStorage
		auth.loadUser().then(() => {
			if (auth.getIsAuthenticated()) {
				hydrate();
			}
		});

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
	<AuthGuard>
		{@render children()}
	</AuthGuard>
</AppShell>
