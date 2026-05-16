// ── Centralized timeouts & magic numbers ────────────────────────────────────
// Keep Effect Config values (ServerConfig) in config.ts; this file holds
// plain numeric constants used across services and routes.

/** Maximum time to wait for a git clone to complete. */
export const CLONE_TIMEOUT_MS = 600_000; // 10 minutes

/** Maximum time for a CLI-driven walkthrough (opencode / claude). */
export const CLI_WALKTHROUGH_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Maximum time for a chat turn. Chat turns can legitimately run much longer
 * than walkthroughs — a single "Request Changes" prompt may ask the agent
 * to address every walkthrough issue with separate commits, each commit
 * involving multiple Read/Edit/Bash tool calls. Mirror the opencode TUI's
 * permissive behaviour: only abort on truly stuck sessions, not on length.
 */
export const CLI_CHAT_TURN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Inactivity timeout for walkthrough stream guard (no events for this long = abort). */
export const WALKTHROUGH_INACTIVITY_TIMEOUT_MS = 120_000; // 120 seconds -- 2 min

/** Timeout for the first event from the AI provider — shorter since healthy providers emit immediately. */
export const WALKTHROUGH_FIRST_EVENT_TIMEOUT_MS = 90_000; // 90 seconds

/** Exploration-stall timeout: if only exploration events arrive for this long with no
 *  summary/block/phase progress, the model is stuck reading files — abort with an error. */
export const WALKTHROUGH_EXPLORATION_STALL_MS = 6 * 60 * 1000; // 6 minutes

/** TTL for the cached CLI agent availability check. */
export const CLI_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** TTL for the in-memory GitHub repo list cache. */
export const REPO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Bun-specific workarounds ────────────────────────────────────────────────

/**
 * Disable Bun's default 5-minute request timeout on a `fetch` Request.
 * Without this, long-running SSE subscriptions and agent-loop HTTP calls
 * are silently aborted by the runtime. Ignored on non-Bun runtimes.
 *
 * See: https://bun.sh/docs/api/fetch — `timeout` is a Bun RequestInit
 * extension not present in the TS lib types, hence the cast.
 */
export function disableBunTimeout(req: Request): void {
  (req as unknown as { timeout?: boolean }).timeout = false;
}
