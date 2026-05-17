import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { newPrSessions } from "./new-pr-sessions";

/**
 * Tool-use rows for a new-PR session — same shape and intent as
 * `chat_activities` but scoped to `new_pr_sessions`.
 *
 * Each row is one tool invocation surfaced to the user (Read, Grep,
 * Bash, Edit, Write, MCP context lookups, etc.). The provider drivers
 * classify the raw tool name into a controlled `activity_kind` so the UI
 * can pick a typed icon + style. The raw provider tool name is preserved
 * in `tool_name` for debugging / parity verification.
 *
 * Sequence shares the per-session monotonic space with `new_pr_messages`
 * so a single ORDER BY sequence reconstructs the timeline.
 */
export const newPrActivities = sqliteTable(
  "new_pr_activities",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => newPrSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    // Controlled vocabulary mirroring chat_activities:
    // 'tool.read' | 'tool.grep' | 'tool.glob' | 'tool.ls' | 'tool.bash'
    // | 'tool.write' | 'tool.edit' | 'tool.todo' | 'tool.mcp'
    // | 'tool.other'.
    activityKind: text("activity_kind").notNull(),
    toolName: text("tool_name"),
    summary: text("summary").notNull(),
    payloadJson: text("payload_json"),
    sequence: integer("sequence").notNull(),
    // Nested under a sub-agent invocation in the UI. ON DELETE SET NULL
    // so dropping an invocation row doesn't cascade-delete tool history.
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
