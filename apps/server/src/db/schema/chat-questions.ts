import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chatSessions } from "./chat-sessions";

/**
 * Retired: nothing reads or writes this table. It stays in users' databases
 * (no drop migration) and stays declared here because the migration snapshot
 * still lists it, so `drizzle-kit generate` would otherwise emit a DROP TABLE.
 */
export const chatQuestions = sqliteTable(
  "chat_questions",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    source: text("source").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    providerToolCallId: text("provider_tool_call_id"),
    previewFormat: text("preview_format").notNull().default("markdown"),
    questionsJson: text("questions_json").notNull(),
    status: text("status").notNull().default("pending"),
    answersJson: text("answers_json"),
    customAnswersJson: text("custom_answers_json"),
    sequence: integer("sequence").notNull(),
    createdAt: text("created_at").notNull(),
    answeredAt: text("answered_at"),
  },
  (t) => ({
    sessionRequestUnique: uniqueIndex("chat_questions_session_request_unique").on(
      t.chatSessionId,
      t.providerRequestId,
    ),
    sessionSeqUnique: uniqueIndex("chat_questions_session_seq_unique").on(
      t.chatSessionId,
      t.sequence,
    ),
    statusIdx: index("chat_questions_status_idx").on(t.chatSessionId, t.status),
  }),
);
