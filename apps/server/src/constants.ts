// ── Centralized timeouts & magic numbers ────────────────────────────────────
// Keep Effect Config values (ServerConfig) in config.ts; this file holds
// plain numeric constants used across services and routes.

/** Maximum time to wait for a git clone to complete. */
export const CLONE_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Absolute ceiling for a CLI-driven walkthrough or recap turn. A backstop for
 * an agent that produces events forever without finishing — NOT a budget. A
 * large PR legitimately takes tens of minutes to review, and killing a
 * still-working agent throws away real work, so liveness is enforced by
 * AGENT_IDLE_TIMEOUT_MS instead and this is set far above any healthy run.
 */
export const CLI_WALKTHROUGH_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

/**
 * Idle deadline for walkthrough/recap turns: abort only when the agent shows NO
 * sign of life — no ACP session update, no MCP content write — for this long.
 * Rearmed by genuine agent activity only (unlike the stream guard's inactivity
 * timer, which the synthetic phase heartbeat also resets), so a slow `Bash`
 * call or a long thinking gap is tolerated while a dead daemon is still caught
 * within minutes. See `ActivityBeacon` in `ai/agent-stream/agent-turn.ts`.
 */
export const AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Absolute ceiling for a chat turn. Chat turns can legitimately run much longer
 * than walkthroughs — a single "Request Changes" prompt may ask the agent
 * to address every walkthrough issue with separate commits, each commit
 * involving multiple Read/Edit/Bash tool calls. Mirror the opencode TUI's
 * permissive behaviour: only abort on truly stuck sessions, not on length.
 */
export const CLI_CHAT_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Idle deadline for chat turns. Longer than AGENT_IDLE_TIMEOUT_MS because chat
 * agents shell out to test suites, builds and installs that emit nothing until
 * they exit — the tool call is one ACP event, then silence until the result.
 */
export const CHAT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Inactivity timeout for walkthrough stream guard (no events for this long = abort).
 *  Providers emit a periodic phase heartbeat every WALKTHROUGH_HEARTBEAT_MS, so this
 *  needs to comfortably exceed that interval. 4× heartbeat margin tolerates a missed
 *  beat without killing a still-running agent. Note the heartbeat is synthetic, so
 *  this timer cannot detect a stalled-but-connected agent — that is the job of
 *  AGENT_IDLE_TIMEOUT_MS in withAgentTurn. */
export const WALKTHROUGH_INACTIVITY_TIMEOUT_MS = 180_000; // 180 seconds -- 3 min

/** Cadence at which each provider pushes a `phase` heartbeat into its event queue
 *  while the prompt is in flight. Keeps the stream guard's inactivity timer reset
 *  even when the model is thinking deeply between tool calls or SSE reasoning-delta
 *  events are temporarily silent. */
export const WALKTHROUGH_HEARTBEAT_MS = 45_000; // 45 seconds

/** Timeout for the first event from the AI provider — shorter since healthy providers emit immediately. */
export const WALKTHROUGH_FIRST_EVENT_TIMEOUT_MS = 90_000; // 90 seconds

/** TTL for the cached CLI agent availability check. */
export const CLI_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** TTL for the in-memory GitHub repo list cache. */
export const REPO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
