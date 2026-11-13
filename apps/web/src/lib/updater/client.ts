// The plugin is imported dynamically to keep the native Tauri IPC calls out of
// the initial bundle.

export type UpdateInfo = {
  version: string;
  notes: string | undefined;
  /** The manifest's optional `pub_date` (ISO 8601). */
  publishedAt: string | undefined;
  /**
   * Downloads and applies the update; throws if either step fails. Restarting
   * is not part of it: on macOS the installer leaves the running process
   * alone, so the relaunch is a separately-failable step the caller owns, and
   * a failed relaunch must not read as a failed install.
   */
  install: () => Promise<void>;
};

/**
 * Per-endpoint timeout for the manifest fetch. The first endpoint is the
 * local API server (`/api/update-manifest`); a wedged server would otherwise
 * hang the check forever, and `runCheck`'s in-flight guard would then suppress
 * every later check. Bounded, the plugin moves on to the GitHub fallback.
 */
const CHECK_TIMEOUT_MS = 15_000;

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
 * Short git hash inlined at build time by `vite.config.ts`; `"unknown"` when
 * git wasn't available.
 */
export function getCommitHash(): string {
  return __COMMIT_HASH__;
}
