import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chatSessions } from "./chat-sessions";

/**
 * The agent's task list, from ACP `plan` session updates. Each update is a
 * full snapshot: rows matching `(chat_session_id, task_id)` are updated in
 * place (keeping `sequence`), new ones inserted; rows missing from a snapshot
 * are left alone.
 *
 * `task_id` is the entry's position in the snapshot: ACP plan entries carry
 * no id.
 *
 * The timeline groups a turn's task rows into one entry at the minimum
 * sequence among them, so the list appears once inline.
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
    // Null from ACP, whose plan entries have no in-progress phrasing; the UI
    // falls back to `content`.
    activeForm: text("active_form"),
    // 'pending' | 'in_progress' | 'completed'
    status: text("status").notNull(),
    // 'low' | 'medium' | 'high' | NULL
    priority: text("priority"),
    // Transport that produced the row: always 'acp'.
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
