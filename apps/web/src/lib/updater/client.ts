// Thin wrapper around `@tauri-apps/plugin-updater` that isolates the rest of
// the app from the plugin API shape.
//
// The plugin imports are dynamic to keep the native Tauri IPC calls out of the
// initial bundle. Same pattern as `auth.svelte.ts`'s
// `await import('@tauri-apps/plugin-opener')`.

/**
 * Normalised view of an available update, returned by {@link checkForUpdate}.
 * The caller uses `version` and `notes` for the toast UI and calls `install`
 * when the user accepts (or automatically, when `autoInstallUpdates` is on).
 */
export type UpdateInfo = {
  version: string;
  notes: string | undefined;
  /**
   * Publish date string from the manifest's `pub_date` field (ISO 8601).
   * `undefined` when the manifest omits it. Used to gate the in-app toast
   * behind a 48-hour cooldown for non-maintainer users on the stable channel
   * — explicit actions (manual "Check now", `revv update`) bypass that gate.
   */
  publishedAt: string | undefined;
  /**
   * Downloads the update package and applies it. Throws if either step
   * fails — callers should `try/catch` to surface the error in a toast.
   *
   * Restarting is deliberately *not* part of this: on macOS the installer
   * leaves the running process alone, so the relaunch is a separate,
   * separately-failable step the caller owns. Folding it in here made a
   * failed relaunch look like a failed install and told the user the update
   * hadn't landed when it had.
   */
  install: () => Promise<void>;
};

/**
 * Per-endpoint timeout for the manifest fetch.
 *
 * The first configured endpoint is the local API server
 * (`/api/update-manifest`), which resolves the release channel. A connection
 * refused there fails instantly, but a wedged server would otherwise hang the
 * request forever — and `runCheck`'s `inFlight` guard would then suppress
 * every subsequent check for the life of the process. Bounding it lets the
 * plugin move on to the GitHub fallback instead.
 */
const CHECK_TIMEOUT_MS = 15_000;

/**
 * Returns the available update, or `null` if we're already on the latest
 * version or the updater is unreachable.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: CHECK_TIMEOUT_MS });
  if (!update) return null;

  return {
    version: update.version,
    notes: update.body,
    publishedAt: update.date,
    install: async () => {
      await update.downloadAndInstall();
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
