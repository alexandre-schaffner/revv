// The desktop shell, installers, CLI and Nix packaging can't import TypeScript,
// so they spell these out; `bun run check:desktop-contract` holds every copy to
// them.

/** GitHub repository that publishes releases, installers and update manifests. */
export const REPO_SLUG = "alexandre-schaffner/revv";

/** Prod-channel data directory name under `~/Library/Application Support`. */
export const APP_DATA_DIR_NAME = "Revv";

/**
 * The desktop host's pid, passed to the server it spawns so the server exits
 * when the host dies without a clean shutdown (force-quit).
 */
export const DESKTOP_PID_ENV = "REVV_DESKTOP_PID";
