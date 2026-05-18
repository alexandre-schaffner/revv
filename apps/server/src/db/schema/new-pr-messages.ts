import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { newPrSessions } from "./new-pr-sessions";

/**
 * Chat transcript for a new-PR session — one row per user or assistant
 * turn-body. Mirrors `chat_messages` (PR-scoped review chat) one-to-one;
 * the only difference is the FK target.
 *
 * Lifecycle:
 *   - User message: inserted at turn start with role='user',
 *                   is_streaming=0, content=<the user's text>,
 *                   finalized_at=created_at.
 *   - Assistant message: inserted lazily at first text chunk OR at turn
 *                   finalize. is_streaming=1 while the agent is
 *                   mid-stream; content is appended to in-place via
 *                   SQL `||`. On finalize: is_streaming=0,
 *                   finalized_at set. On error: `error` populated.
 *
 * Sequence is per-session monotonic, allocated against
 * `new_pr_sessions.next_sequence` so it shares one ordering space with
 * `new_pr_activities`. `turn_id` groups (user_message, assistant_message,
 * activities) for the same user→agent exchange.
 */
export const newPrMessages = sqliteTable(
  "new_pr_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => newPrSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: text("content").notNull().default(""),
    isStreaming: integer("is_streaming").notNull().default(0),
    sequence: integer("sequence").notNull(),
    turnId: text("turn_id").notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    finalizedAt: text("finalized_at"),
  },
  (t) => ({
    sessionSeqUnique: uniqueIndex("new_pr_messages_session_seq_unique").on(
      t.sessionId,
      t.sequence,
    ),
    sessionIdx: index("new_pr_messages_session_idx").on(t.sessionId),
  }),
);
