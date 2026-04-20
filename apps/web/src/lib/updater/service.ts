// Runtime driver for the in-app updater.
//
// Flow:
//   1. `startUpdater()` is called once from the root layout, after settings
//      have been fetched so `autoInstallUpdates` is known.
//   2. ~5s later we run the first check (delay is in the caller — see the
//      root layout — so startup network goes to the PR sync first).
//   3. Every hour thereafter we run another check.
//   4. On finding an update:
//        - if auto-install is OFF, show a persistent Sonner toast with
//          Install / Dismiss buttons
//        - if auto-install is ON, download + install silently and (on
//          success) relaunch. If the relaunch throws, fall back to the
//          same toast flow so the user can retry manually.
//
// Dismissals are session-scoped: we store the dismissed version in a
// module-level variable so the toast doesn't reappear on the next hourly
// tick, but a full app restart resets it. That's intentional — if the user
// dismisses an update and then leaves the app running for a week, the next
// launch should offer it again.

import { toast } from 'svelte-sonner';
import Download from '@lucide/svelte/icons/download';
import { isTauri } from '$lib/utils/platform';
import { getSettings } from '$lib/stores/settings.svelte';
import { checkForUpdate, type UpdateInfo } from './client';

const HOURLY_MS = 60 * 60 * 1000;

let started = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let dismissedVersion: string | null = null;
let inFlight = false;

/**
 * Kick off the background update checker. Idempotent and a no-op outside
 * Tauri. Call this from the root layout's `$effect` once settings have
 * been loaded.
 */
export function startUpdater(): void {
	if (started || !isTauri()) return;
	started = true;
	// First check runs immediately — the caller is expected to delay this
	// call with a setTimeout so it doesn't compete with initial PR sync.
	void runCheck();
	intervalId = setInterval(() => {
		void runCheck();
	}, HOURLY_MS);
}

/** Stops the hourly checker. Useful for tests + hot-reload cleanup. */
export function stopUpdater(): void {
	if (intervalId !== null) {
		clearInterval(intervalId);
		intervalId = null;
	}
	started = false;
}

/**
 * Run a single update check. Exported so the Settings "Check for updates
 * now" button can reuse the same code path as the background loop. When
 * `manual` is true, callers get an "up to date" toast on the miss path
 * instead of silent no-op.
 */
export async function runCheck(options: { manual?: boolean } = {}): Promise<void> {
	if (inFlight) return;
	inFlight = true;
	try {
		const update = await checkForUpdate();
		if (!update) {
			if (options.manual) {
				toast.success("You're up to date", {
					description: 'No new version available.',
				});
			}
			return;
		}
		if (!options.manual && update.version === dismissedVersion) {
			// User already dismissed this version during this session; don't
			// re-toast on every hourly tick. The flag resets on app restart.
			return;
		}
		const autoInstall = getSettings()?.autoInstallUpdates ?? false;
		if (autoInstall) {
			try {
				await update.install();
				// If `install()` succeeds the app has already been relaunched
				// and we never reach this line. If we do, the relaunch call
				// returned without tearing down the process — show the
				// fallback toast so the user can restart manually.
				showRestartFallbackToast();
			} catch (err) {
				console.error('auto-install failed, falling back to prompt', err);
				showUpdateToast(update);
			}
		} else {
			showUpdateToast(update);
		}
	} catch (err) {
		// Background checks fail silently — the endpoint might be down, the
		// user might be offline, etc. Surface errors only for manual checks.
		console.error('updater check failed', err);
		if (options.manual) {
			toast.error('Update check failed', {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	} finally {
		inFlight = false;
	}
}

function showUpdateToast(update: UpdateInfo): void {
	// Sonner's `duration: Infinity` keeps the toast open until the user
	// explicitly acts. The Install button triggers download+install; Dismiss
	// records the version so we don't re-nag until the next launch.
	toast(`Update available — v${update.version}`, {
		description: update.notes ?? 'A new version of Revv is ready to install.',
		duration: Number.POSITIVE_INFINITY,
		icon: Download,
		action: {
			label: 'Install',
			onClick: () => {
				void installWithProgress(update);
			},
		},
		cancel: {
			label: 'Dismiss',
			onClick: () => {
				dismissedVersion = update.version;
			},
		},
	});
}

async function installWithProgress(update: UpdateInfo): Promise<void> {
	const id = toast.loading(`Installing v${update.version}…`, {
		description: 'Downloading and applying the update.',
		duration: Number.POSITIVE_INFINITY,
	});
	try {
		await update.install();
		// As with auto-install: if relaunch() returned without tearing the
		// process down, prompt the user to restart. Most of the time we
		// never reach this branch.
		toast.dismiss(id);
		showRestartFallbackToast();
	} catch (err) {
		toast.dismiss(id);
		toast.error('Update failed', {
			description: err instanceof Error ? err.message : String(err),
		});
	}
}

function showRestartFallbackToast(): void {
	toast('Update installed', {
		description: 'Restart Revv to finish applying the update.',
		duration: Number.POSITIVE_INFINITY,
		action: {
			label: 'Restart now',
			onClick: () => {
				void relaunchNow();
			},
		},
	});
}

async function relaunchNow(): Promise<void> {
	try {
		const { relaunch } = await import('@tauri-apps/plugin-process');
		await relaunch();
	} catch (err) {
		toast.error('Failed to restart', {
			description: err instanceof Error ? err.message : String(err),
		});
	}
}
