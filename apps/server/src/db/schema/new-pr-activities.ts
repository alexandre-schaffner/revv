import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { newPrSessions } from "./new-pr-sessions";

/**
 * Retired: nothing reads or writes this table. It stays in users' databases
 * (no drop migration) and stays declared here because the migration snapshot
 * still lists it, so `drizzle-kit generate` would otherwise emit a DROP TABLE.
 */
export const newPrActivities = sqliteTable(
  "new_pr_activities",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => newPrSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    activityKind: text("activity_kind").notNull(),
    toolName: text("tool_name"),
    summary: text("summary").notNull(),
    payloadJson: text("payload_json"),
    sequence: integer("sequence").notNull(),
    subagentInvocationId: text("subagent_invocation_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    sessionSeqUnique: uniqueIndex("new_pr_activities_session_seq_unique").on(
      t.sessionId,
      t.sequence,
    ),
    sessionIdx: index("new_pr_activities_session_idx").on(t.sessionId),
  }),
);
