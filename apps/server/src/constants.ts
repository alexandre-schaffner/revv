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

/** Inactivity timeout for walkthrough stream guard (no events for this long = abort).
 *  Providers emit a periodic phase heartbeat every WALKTHROUGH_HEARTBEAT_MS, so this
 *  needs to comfortably exceed that interval. 4× heartbeat margin tolerates a missed
 *  beat without killing a still-running agent; the 10-min withAgentTurn hard wall
 *  remains the real backstop for a genuinely dead daemon. */
export const WALKTHROUGH_INACTIVITY_TIMEOUT_MS = 180_000; // 180 seconds -- 3 min

/** Cadence at which each provider pushes a `phase` heartbeat into its event queue
 *  while the prompt is in flight. Keeps the stream guard's inactivity timer reset
 *  even when the model is thinking deeply between tool calls or SSE reasoning-delta
 *  events are temporarily silent. */
export const WALKTHROUGH_HEARTBEAT_MS = 45_000; // 45 seconds

/** Timeout for the first event from the AI provider — shorter since healthy providers emit immediately. */
export const WALKTHROUGH_FIRST_EVENT_TIMEOUT_MS = 90_000; // 90 seconds

/** Exploration-stall timeout: if only exploration events arrive for this long with no
 *  summary/block/phase progress, the model is stuck reading files — abort with an error. */
export const WALKTHROUGH_EXPLORATION_STALL_MS = 6 * 60 * 1000; // 6 minutes

/** TTL for the cached CLI agent availability check. */
export const CLI_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** TTL for the in-memory GitHub repo list cache. */
export const REPO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
