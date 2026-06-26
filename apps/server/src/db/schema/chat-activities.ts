import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chatSessions } from "./chat-sessions";

/**
 * Right-pane chat tool-use rows. The structured replacement for the opaque
 * `{kind: 'tool', data: string}` SSE frame the previous design forwarded.
 *
 * Each row is one tool invocation surfaced to the user (Read, Grep, Bash,
 * Edit, Write, MCP context lookups, etc.). The provider drivers classify the
 * raw tool name into a controlled `activity_kind` so the UI can pick a typed
 * icon + style and so future approval flows (gap C2) can attach without a
 * schema change. The raw provider tool name is preserved in `tool_name` for
 * debugging / parity verification across drivers.
 *
 * Sequence shares the per-session monotonic space with `chat_messages` so a
 * single ORDER BY sequence reconstructs the timeline.
 *
 * `payload_json` is best-effort: the Claude Agent SDK exposes the raw tool
 * input so we capture it; opencode emits structured tool events but we
 * currently only translate into a description string, so payload may be null.
 * Future work (F1: canonical ProviderRuntimeEvent) standardises this.
 */
export const chatActivities = sqliteTable(
  "chat_activities",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    // Controlled vocabulary: 'tool.read' | 'tool.grep' | 'tool.glob' |
    // 'tool.ls' | 'tool.bash' | 'tool.write' | 'tool.edit' |
    // 'tool.todo' | 'tool.mcp' | 'tool.other'.
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
    // Optional FK to chat_subagent_invocations. When set, this activity row
    // is a tool call made *inside* a sub-agent (Claude `Task` or opencode
    // agent part). The UI nests it under the parent SubagentInvocation card
    // instead of rendering at top level. ON DELETE SET NULL so dropping an
    // invocation row doesn't cascade-delete the tool history.
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
