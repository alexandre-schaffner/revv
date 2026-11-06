// The desktop shell, installers, CLI and Nix packaging can't import TypeScript,
// so they spell these out; `bun run check:desktop-contract` holds every copy to
// them.

/** GitHub repository that publishes releases, installers and update manifests. */
export const REPO_SLUG = "alexandre-schaffner/revv";

/** Prod-channel data directory name under `~/Library/Application Support`. */
export const APP_DATA_DIR_NAME = "Revv";
