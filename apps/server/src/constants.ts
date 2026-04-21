// ── Centralized timeouts & magic numbers ────────────────────────────────────
// Keep Effect Config values (ServerConfig) in config.ts; this file holds
// plain numeric constants used across services and routes.

/** Maximum time to wait for a git clone to complete. */
export const CLONE_TIMEOUT_MS = 600_000; // 10 minutes

/** Maximum time for a CLI-driven walkthrough (opencode / claude). */
export const CLI_WALKTHROUGH_TIMEOUT_MS = 600_000; // 10 minutes

/** Inactivity timeout for walkthrough stream guard (no events for this long = abort). */
export const WALKTHROUGH_INACTIVITY_TIMEOUT_MS = 120_000; // 120 seconds -- 2 min

/** Timeout for the first event from the AI provider — shorter since healthy providers emit immediately. */
export const WALKTHROUGH_FIRST_EVENT_TIMEOUT_MS = 90_000; // 90 seconds

/** Exploration-stall timeout: if only exploration events arrive for this long with no
 *  summary/block/phase progress, the model is stuck reading files — abort with an error. */
export const WALKTHROUGH_EXPLORATION_STALL_MS = 3 * 60 * 1000; // 3 minutes

/** Maximum time for an SDK-driven walkthrough (direct Anthropic API). */
export const SDK_WALKTHROUGH_TIMEOUT_MS = 120_000; // 2 minutes

/** TTL for the cached CLI agent availability check. */
export const CLI_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** TTL for the in-memory GitHub repo list cache. */
export const REPO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** How many times to poll clone status before giving up (× POLL_CLONE_INTERVAL_SECONDS). */
export const POLL_CLONE_MAX_ATTEMPTS = 200; // 200 × 3s = 10 minutes

/** Seconds between clone-status poll checks. */
export const POLL_CLONE_INTERVAL_SECONDS = 3;
