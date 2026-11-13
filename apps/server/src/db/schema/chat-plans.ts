import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chatSessions } from "./chat-sessions";

/**
 * Plans the agent presented for approval. In plan mode the turn's whole
 * assistant text is the plan (`ai/providers/chat-acp.ts`), so a turn has at
 * most one; the unique `(chat_session_id, turn_id)` index enforces it.
 * Approving a plan sends its id as the next turn's `approvedPlanId`.
 *
 * Status: 'pending' awaits the user's decision; 'approved' / 'rejected' set
 * `decidedAt`. Nothing writes 'superseded'.
 */
export const chatPlans = sqliteTable(
  "chat_plans",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    planMarkdown: text("plan_markdown").notNull(),
    // 'pending' | 'approved' | 'rejected' | 'superseded'
    status: text("status").notNull().default("pending"),
    // Transport that produced the row: always 'acp'.
    source: text("source").notNull(),
    sequence: integer("sequence").notNull(),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => ({
    sessionTurnUnique: uniqueIndex("chat_plans_session_turn_unique").on(t.chatSessionId, t.turnId),
    sessionSeqUnique: uniqueIndex("chat_plans_session_seq_unique").on(t.chatSessionId, t.sequence),
    sessionIdx: index("chat_plans_session_idx").on(t.chatSessionId),
  }),
);
