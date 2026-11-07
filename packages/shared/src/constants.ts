export type AppChannel = "prod" | "dev";

export const DEFAULT_APP_CHANNEL: AppChannel = "prod";

// The Tauri config, the desktop host, the installers and the CLI can't import
// these ports, so they spell them out; `bun run check:desktop-contract` names
// every copy to edit when one changes. flake.nix reads API_PORT with a regex:
// keep the `export const API_PORT = <number>;` shape.
export const API_PORT = 45678;
export const DEV_API_PORT = 45679;

// apps/collector: one port serves OTLP ingest and the archive query API.
export const COLLECTOR_PORT = 45680;
export const COLLECTOR_BASE_URL = `http://localhost:${COLLECTOR_PORT}`;

export const AUTO_FETCH_DEFAULT_INTERVAL = 5; // minutes
export const THREAD_SYNC_INTERVAL_SECONDS = 5 * 60;
/**
 * How recently a PR-list sync must have started for a "freshen" (a window
 * opening or regaining focus) to skip. The server skips such a request; the
 * web throttles its asks to the same window, since asking more often only
 * spends requests.
 */
export const FRESHEN_MIN_INTERVAL_MS = 2 * 60 * 1000;

// How long after publication a stable release waits before the passive update
// check offers it to non-maintainers, so maintainers and nightly users can
// catch fatal regressions first. Explicit checks (`revv update`, "Check for
// updates now") bypass it.
export const UPDATE_STABLE_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;

export type UpdateChannel = "stable" | "nightly";
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "nightly"];
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = "stable";
