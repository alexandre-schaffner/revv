import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chatSessions } from "./chat-sessions";

/**
 * Right-pane chat transcript — one row per user message, one row per
 * contiguous run of assistant prose.
 *
 * Lifecycle:
 *   - User message: inserted at turn start with role='user', is_streaming=0,
 *                   content=<the user's text>, finalized_at=created_at.
 *   - Assistant message: inserted lazily at the first text chunk of a run OR
 *                   at turn finalize. is_streaming=1 while the agent is
 *                   mid-run; content is appended to in-place via SQL `||`.
 *                   On finalize: is_streaming=0, finalized_at set. On error:
 *                   `error` populated with the inline-error chip text.
 *                   A narrate→tool→narrate turn yields two assistant rows
 *                   split by the activity; see `services/chat/turn-journal.ts`.
 *
 * Sequence is per-session monotonic, allocated against
 * `chat_sessions.next_sequence` so it shares one ordering space with
 * `chat_activities`. This lets the UI interleave activity rows between
 * user and assistant turns without timestamp-jitter ambiguity.
 *
 * `turn_id` groups the user message, assistant messages and activities of one
 * user→agent exchange.
 */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: text("content").notNull().default(""),
    attachmentsJson: text("attachments_json"),
    isStreaming: integer("is_streaming").notNull().default(0),
    sequence: integer("sequence").notNull(),
    turnId: text("turn_id").notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    finalizedAt: text("finalized_at"),
  },
  (t) => ({
    sessionSeqUnique: uniqueIndex("chat_messages_session_seq_unique").on(
      t.chatSessionId,
      t.sequence,
    ),
    sessionIdx: index("chat_messages_session_idx").on(t.chatSessionId),
  }),
);
