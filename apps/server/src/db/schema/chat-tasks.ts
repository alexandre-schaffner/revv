import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chatSessions } from "./chat-sessions";

/**
 * Agent task list (Claude's `TodoWrite` tool / opencode's daemon-maintained
 * todos surfaced via `todo.updated` SSE).
 *
 * Both providers emit FULL snapshots of the current list — there are no
 * incremental events. Our service performs snapshot reconciliation: rows
 * matching by `(chat_session_id, task_id)` are updated in place (preserving
 * `sequence`), new rows inserted at fresh sequences. Rows missing from a
 * snapshot are LEFT ALONE in v1 — the snapshot is "the current view", not
 * "delete-the-rest". Reconsider if users report drift.
 *
 * `task_id` source:
 *   - opencode: the daemon supplies a stable id per todo. Use it directly.
 *   - Claude TodoWrite: the SDK input has no id field. We content-hash
 *     `(content + activeForm ?? '')` for stability across snapshot updates.
 *     Two identical tasks collapse — acceptable since this is a display list.
 *
 * `sequence` shares the per-session monotonic space with `chat_messages`,
 * `chat_activities`, `chat_plans`, and `chat_subagent_invocations`. Each task
 * gets its own sequence on first insert, then sticks with it. The route
 * groups all task rows of a turn into a single timeline entry positioned at
 * the *minimum* sequence among the turn's tasks (so the list appears once
 * inline, not as N scattered rows).
 */
export const chatTasks = sqliteTable(
  "chat_tasks",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    taskId: text("task_id").notNull(),
    content: text("content").notNull(),
    // Claude TodoWrite supplies the in-progress phrasing ("Reading file X");
    // opencode does not. Nullable so the UI can fall back to `content` when
    // missing.
    activeForm: text("active_form"),
    // 'pending' | 'in_progress' | 'completed'
    status: text("status").notNull(),
    // 'low' | 'medium' | 'high' | NULL
    priority: text("priority"),
    // 'claude' | 'opencode' — for debugging parity divergence.
    source: text("source").notNull(),
    sequence: integer("sequence").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    sessionTaskUnique: uniqueIndex("chat_tasks_session_task_unique").on(t.chatSessionId, t.taskId),
    sessionSeqUnique: uniqueIndex("chat_tasks_session_seq_unique").on(t.chatSessionId, t.sequence),
    sessionIdx: index("chat_tasks_session_idx").on(t.chatSessionId),
  }),
);
