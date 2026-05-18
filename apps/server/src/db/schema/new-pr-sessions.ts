import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { pullRequests } from "./pull-requests";
import { repositories } from "./repositories";

/**
 * Persistent handle for a new-PR chat session.
 *
 * A session represents a long-running, user-driven conversation with the
 * agent that produces an entirely new pull request. The shape mirrors
 * `chat_sessions` (PR-scoped review chat) but is scoped to a repository
 * instead — there is no existing PR to anchor against until the session
 * terminates with an "open PR" action.
 *
 * Lifecycle:
 *   - `chatting`        — normal interactive state; user sends messages,
 *                         agent edits files in the worktree, optionally
 *                         commits via the MCP tool surface.
 *   - `agent-running`   — transient: a single agent turn is in flight.
 *                         Rolled back to `chatting` on server restart.
 *   - `opening`         — durable: user clicked Open PR; orchestrator is
 *                         pushing the branch + calling GitHub. Retries
 *                         bounded via `resume_attempts`.
 *   - `complete`        — PR opened; `pr_id` and `pr_external_id` set.
 *   - `error`           — terminal failure; `error_message` populated.
 *   - `cancelled`       — user aborted; worktree cleaned.
 *
 * NOT a doctrine-bound jobs table (CLAUDE.md "Agent Subsystem
 * Invariants") — same carve-out as `chat_sessions`. The only durable
 * artefacts are this row + `new_pr_messages` + `new_pr_activities` +
 * `new_pr_commits` + the on-disk git worktree. Writes are confined to
 * the worktree (a reconstructible cache); `kill -9` mid-edit at worst
 * loses an uncommitted edit. The push+open step *is* doctrine-bound —
 * see `NewPrSessionService.requestOpenPr` for the orchestrator-only
 * status writes and resume contract.
 *
 * Agent-side `sessionId` is patched in after the first turn (same as
 * `chat_sessions.session_id`). It addresses the live Claude SDK / opencode
 * session for resume; lost on agent-side eviction, in which case the next
 * turn starts a fresh agent session and we re-link.
 */
export const newPrSessions = sqliteTable(
  "new_pr_sessions",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // 'claude' | 'opencode' — snapshot at session start; subsequent
    // turns must reuse the same agent for parity with chat_sessions.
    agent: text("agent").notNull(),
    // Agent-side session UUID (Claude SDK / opencode). Nullable so the
    // first turn can create the row eagerly and patch this in once the
    // SDK emits it. Required to be non-null on follow-up turns.
    sessionId: text("session_id"),
    // origin/main HEAD captured at session start. The worktree is
    // created here; the "Sync with main" action advances it.
    baseSha: text("base_sha").notNull(),
    worktreePath: text("worktree_path").notNull(),
    // Ephemeral local branch checked out in the worktree.
    // Convention: `revv-newpr/{sessionId}`.
    branchName: text("branch_name").notNull(),
    // Mutated as conversation progresses via `set_pr_metadata` MCP tool.
    // Pre-filled into the Open-PR dialog so the user can review/edit.
    title: text("title"),
    body: text("body"),
    // Set after a successful Open-PR action.
    prExternalId: integer("pr_external_id"),
    prId: text("pr_id").references(() => pullRequests.id, { onDelete: "set null" }),
    // Orchestrator-only writes. 'chatting' | 'agent-running' | 'opening'
    // | 'complete' | 'error' | 'cancelled'.
    status: text("status").notNull().default("chatting"),
    // Per-session monotonic counter shared by `new_pr_messages` and
    // `new_pr_activities`. Same allocator pattern as `chat_sessions`.
    nextSequence: integer("next_sequence").notNull().default(0),
    // Boot-resume retry budget for the `opening` step. Reset to 0 when
    // the user manually retries from the UI.
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    errorMessage: text("error_message"),
    // t3code-style session-level interaction toggle. 'default' | 'plan'.
    // Persists across turns until the user toggles it back or auto-flip
    // happens on plan approval.
    interactionMode: text("interaction_mode").notNull().default("default"),
    createdAt: text("created_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => ({
    statusIdx: index("new_pr_sessions_status_idx").on(t.status),
    userRepoIdx: index("new_pr_sessions_user_repo_idx").on(t.userId, t.repositoryId, t.createdAt),
  }),
);
