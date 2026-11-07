import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pullRequests } from "./pull-requests";

/**
 * The right-pane AI chat's durable handle on an agent conversation, scoped to
 * `(pullRequestId, agent, model, prHeadSha)`. A new PR head means a new row
 * and a new agent session, except where the conversation itself moved the
 * head (the agent's push, or advancing past its commits): there the latest
 * row's `prHeadSha` moves with it (`PrWorkspace.moveSession`). The unique
 * index makes the chat turn's upsert idempotent.
 *   - `sessionId`     — the agent's ACP session id. Null until the agent opens
 *                       the session; follow-up turns resume it.
 *   - `worktreePath`  — the PR's agent worktree (see `PrWorkspace`), the
 *                       agent's `cwd`.
 *   - `branchName`    — the agent branch (`revv/pr-{prNumber}`) the agent
 *                       commits its proposed changes to.
 *   - `nextSequence`  — per-session monotonic counter shared by the chat
 *                       timeline tables. Allocated atomically on every insert
 *                       so the timeline reconstructs in arrival order without
 *                       relying on timestamp resolution.
 *
 * NOT a doctrine-bound jobs table (CLAUDE.md "Agent Subsystem Invariants"):
 * `kill -9` mid-edit at worst loses an uncommitted edit in the worktree,
 * which is acceptable for an in-progress AI suggestion.
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
    // 'default' | 'plan'. In 'plan' the turn opens the ACP session in the
    // agent's plan mode. Persists across turns until the user toggles it back or
    // approves a plan.
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
