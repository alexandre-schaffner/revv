export type AppChannel = "prod" | "dev";

export const APP_CHANNELS: readonly AppChannel[] = ["prod", "dev"];
export const DEFAULT_APP_CHANNEL: AppChannel = "prod";

// Changing API_PORT means also changing the updater endpoint hard-coded in
// `apps/desktop/tauri.conf.json` → `plugins.updater.endpoints[0]`. That file
// is plain JSON evaluated by the Rust host before any TS runs, so it cannot
// import this constant. See `docs/updater-setup.md`.
export const API_PORT = 45678;
export const DEV_API_PORT = 45679;
export const API_BASE_URL = `http://localhost:${API_PORT}`;
export const AUTO_FETCH_DEFAULT_INTERVAL = 5; // minutes
export const THREAD_SYNC_INTERVAL_SECONDS = 5 * 60;

// Stable-channel cooldown: how long after a release is published before
// non-maintainer users on the stable channel see the in-app update toast.
// The buffer lets maintainers and nightly users catch fatal regressions
// before they propagate to everyone. Explicit user actions (CLI `revv update`,
// Settings "Check for updates now") bypass this — it only gates the
// passive hourly check.
export const UPDATE_STABLE_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;

export type UpdateChannel = "stable" | "nightly";
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "nightly"];
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = "stable";
