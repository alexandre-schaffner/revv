import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pullRequests } from "./pull-requests";

/**
 * Persistent mapping for the right-pane AI chat session.
 *
 * Each row is the durable handle for a live agent conversation scoped to
 * `(pullRequestId, agent, model, prHeadSha)`:
 *   - `sessionId`     — the agent-side session UUID. Nullable so the route
 *                       can create the row eagerly when the user sends the
 *                       first message and patch in the agent-side id once
 *                       the SDK / daemon emits it. Required to be non-null
 *                       on follow-up turns (resume).
 *                       Claude Agent SDK: UUID under `~/.claude/projects/<dir>/`.
 *                       Opencode: the daemon's session id.
 *   - `worktreePath`  — absolute path to the chat worktree (`chat-{prId}-{sha12}`)
 *                       checked out at `prHeadSha`. The agent's `cwd`.
 *   - `branchName`    — the local PR tracking branch (`revv/pr-{prNumber}`) the
 *                       agent commits its proposed changes to.
 *   - `nextSequence`  — per-session monotonic counter shared by `chat_messages`
 *                       and `chat_activities`. Allocated atomically on every
 *                       insert so the timeline can be reconstructed in
 *                       arrival order without relying on timestamp resolution.
 *
 * A new commit on the PR ⇒ different `prHeadSha` ⇒ new row, new agent
 * session, fresh worktree on a fresh branch. The unique index makes the
 * orchestrator's upsert in the chat route naturally idempotent.
 *
 * NOT a doctrine-bound jobs table (CLAUDE.md "Agent Subsystem Invariants"):
 * the only durable artefacts are this row + chat_messages + chat_activities
 * + the on-disk git worktree. Writes are confined to the worktree (a
 * reconstructible cache); `kill -9` mid-edit at worst loses an uncommitted
 * edit, which is acceptable for an in-progress AI suggestion.
 */
export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(), // ACP registry id: 'claude-code' | 'opencode' | 'codex' | 'cursor'
    model: text("model").notNull().default(""),
    sessionId: text("session_id"),
    prHeadSha: text("pr_head_sha").notNull(),
    worktreePath: text("worktree_path").notNull(),
    branchName: text("branch_name").notNull(),
    nextSequence: integer("next_sequence").notNull().default(0),
    // 'default' | 'plan' — t3code-style session-level interaction toggle.
    // In 'plan' mode the driver flips Claude into `permissionMode: 'plan'`
    // or routes opencode through its named `plan` agent. The flag persists
    // across turns until the user toggles it back or auto-flip happens on
    // plan approval.
    interactionMode: text("interaction_mode").notNull().default("default"),
    createdAt: text("created_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
  },
  (t) => ({
    prAgentModelShaUnique: uniqueIndex("chat_sessions_pr_agent_model_sha_unique").on(
      t.pullRequestId,
      t.agent,
      t.model,
      t.prHeadSha,
    ),
  }),
);
