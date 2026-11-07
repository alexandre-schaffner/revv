import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { newPrSessions } from "./new-pr-sessions";

/**
 * Retired: nothing reads or writes this table. It stays in users' databases
 * (no drop migration) and stays declared here because the migration snapshot
 * still lists it, so `drizzle-kit generate` would otherwise emit a DROP TABLE.
 */
export const newPrMessages = sqliteTable(
  "new_pr_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => newPrSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull().default(""),
    isStreaming: integer("is_streaming").notNull().default(0),
    sequence: integer("sequence").notNull(),
    turnId: text("turn_id").notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    finalizedAt: text("finalized_at"),
  },
  (t) => ({
    sessionSeqUnique: uniqueIndex("new_pr_messages_session_seq_unique").on(t.sessionId, t.sequence),
    sessionIdx: index("new_pr_messages_session_idx").on(t.sessionId),
  }),
);
