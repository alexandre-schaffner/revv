// Thin wrapper around `@tauri-apps/plugin-updater` that isolates the rest of
// the app from the plugin API shape and from the "are we running in Tauri?"
// guard. Every export here is safe to call from the browser dev build
// (`make dev-web`) — outside Tauri they either return `null` / a sensible
// fallback or are no-ops.
//
// The plugin imports are dynamic so that Vite doesn't try to bundle native
// Tauri IPC calls into the browser build. Same pattern as
// `auth.svelte.ts`'s `await import('@tauri-apps/plugin-opener')`.

import { isTauri } from '$lib/utils/platform';

/**
 * Normalised view of an available update, returned by {@link checkForUpdate}.
 * The caller uses `version` and `notes` for the toast UI and calls `install`
 * when the user accepts (or automatically, when `autoInstallUpdates` is on).
 */
export type UpdateInfo = {
	version: string;
	notes: string | undefined;
	/**
	 * Downloads the update package, applies it, and relaunches the app.
	 * Throws if any step fails — callers should `try/catch` to surface the
	 * error in a toast.
	 */
	install: () => Promise<void>;
};

/**
 * Returns the available update, or `null` if we're already on the latest
 * version, the updater is unreachable, or we're running outside of Tauri
 * (i.e. the browser dev build).
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
	if (!isTauri()) return null;

	const { check } = await import('@tauri-apps/plugin-updater');
	const update = await check();
	if (!update) return null;

	return {
		version: update.version,
		notes: update.body,
		install: async () => {
			await update.downloadAndInstall();
			// On Windows/Linux the plugin's passive install mode exits the
			// running process; on macOS we must explicitly relaunch so the
			// user lands back in the new version immediately. Calling
			// `relaunch()` is a no-op if the process is already exiting.
			const { relaunch } = await import('@tauri-apps/plugin-process');
			await relaunch();
		},
	};
}

/**
 * Short git commit hash snapshotted at build time. Displayed in Settings
 * in place of the semver from `tauri.conf.json` so every alpha build is
 * individually identifiable (the semver changes rarely during alpha; the
 * commit always moves). Falls back to the literal `"unknown"` string when
 * git wasn't available at build time — see `vite.config.ts`.
 *
 * This is synchronous because the value is inlined by Vite's `define` at
 * build time. Exposed as a function anyway so the call site doesn't need
 * to reach for the global directly.
 */
export function getCommitHash(): string {
	return __COMMIT_HASH__;
}
