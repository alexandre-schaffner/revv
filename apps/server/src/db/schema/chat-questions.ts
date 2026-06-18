import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chatSessions } from "./chat-sessions";

/**
 * Interactive questions the agent has asked the user. Distinct from `chat_plans`
 * because:
 *   - Multiple questions can fire in one turn (one per `askUserQuestion`
 *     tool call / `question.asked` event), so we key on
 *     (chat_session_id, provider_request_id) rather than turn id.
 *   - The questions+options payload is structured, not free-form markdown.
 *   - Answer routing is provider-specific: Claude resolves in-memory via
 *     `canUseTool`'s deferred; opencode replies via HTTP to its daemon.
 *
 * Sources:
 *   - Claude: emitted on `tool_use { name: "askUserQuestion" }` intercepted
 *     by the SDK's `canUseTool` callback. `provider_request_id` = tool_use.id.
 *   - Opencode: emitted on the `question.asked` event from the daemon's
 *     `/global/event` stream. `provider_request_id` = QuestionRequest.id.
 *
 * Status lifecycle:
 *   - 'pending'    — emitted by agent, awaiting user decision
 *   - 'answered'   — user submitted answers via /answer endpoint
 *   - 'rejected'   — user dismissed the prompt via /answer with decision='reject'
 *   - 'superseded' — set on boot for any rows left 'pending' across a
 *                    server restart; the in-memory deferred is gone so
 *                    the Claude SDK turn (or opencode session) is dead.
 *                    The UI renders these muted.
 */
export const chatQuestions = sqliteTable(
  "chat_questions",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    // Transport that produced the row: always 'acp'.
    source: text("source").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    // opencode-only — links back to the tool call that issued the question
    // (`QuestionRequest.tool.callID`). Null for claude.
    providerToolCallId: text("provider_tool_call_id"),
    previewFormat: text("preview_format").notNull().default("markdown"),
    questionsJson: text("questions_json").notNull(),
    // 'pending' | 'answered' | 'rejected' | 'superseded'
    status: text("status").notNull().default("pending"),
    // JSON: Record<questionText, string[]>
    answersJson: text("answers_json"),
    // JSON: Record<questionText, string> — opencode `allowCustom` free-text capture
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
