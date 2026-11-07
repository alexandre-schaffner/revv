import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chatSessions } from "./chat-sessions";

/**
 * Right-pane chat tool calls, one row per invocation surfaced to the user.
 * `tool_name` keeps the agent's raw tool name.
 *
 * Sequence shares the per-session monotonic space with `chat_messages` so a
 * single ORDER BY sequence reconstructs the timeline.
 *
 * `payload_json` is the tool input as the agent reported it; null when it
 * reported none.
 */
export const chatActivities = sqliteTable(
  "chat_activities",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    // `ActivityKind` from `@revv/shared`.
    activityKind: text("activity_kind").notNull(),
    toolName: text("tool_name"),
    summary: text("summary").notNull(),
    payloadJson: text("payload_json"),
    // Provider tool-call id (ACP `toolCallId`). Lets the later tool result
    // (streamed as an `activity-result` frame) be matched back to this row.
    callId: text("call_id"),
    // Captured terminal output of the tool call (stdout / result text / error),
    // truncated by the decoder. Null until the result arrives (best-effort —
    // some agents never report a terminal tool-call status). Powers the
    // clickable output peek.
    output: text("output"),
    isError: integer("is_error", { mode: "boolean" }),
    sequence: integer("sequence").notNull(),
    // Nothing sets this any more: `chat_subagent_invocations` is retired.
    subagentInvocationId: text("subagent_invocation_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    sessionSeqUnique: uniqueIndex("chat_activities_session_seq_unique").on(
      t.chatSessionId,
      t.sequence,
    ),
    sessionIdx: index("chat_activities_session_idx").on(t.chatSessionId),
    // Result frames arrive keyed by (session, provider call id); index the
    // lookup that stamps them onto the originating row.
    sessionCallIdx: index("chat_activities_session_call_idx").on(t.chatSessionId, t.callId),
  }),
);
