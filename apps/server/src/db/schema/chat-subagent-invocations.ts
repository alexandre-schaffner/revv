import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chatSessions } from "./chat-sessions";

/**
 * Retired: nothing reads or writes this table. It stays in users' databases
 * (no drop migration) and stays declared here because the migration snapshot
 * still lists it, so `drizzle-kit generate` would otherwise emit a DROP TABLE.
 */
export const chatSubagentInvocations = sqliteTable(
  "chat_subagent_invocations",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    parentTurnId: text("parent_turn_id").notNull(),
    providerCallId: text("provider_call_id").notNull(),
    subagentType: text("subagent_type").notNull(),
    description: text("description").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status").notNull().default("running"),
    result: text("result"),
    source: text("source").notNull(),
    sequence: integer("sequence").notNull(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => ({
    sessionCallUnique: uniqueIndex("chat_subagent_invocations_session_call_unique").on(
      t.chatSessionId,
      t.providerCallId,
    ),
    sessionSeqUnique: uniqueIndex("chat_subagent_invocations_session_seq_unique").on(
      t.chatSessionId,
      t.sequence,
    ),
    sessionIdx: index("chat_subagent_invocations_session_idx").on(t.chatSessionId),
  }),
);
