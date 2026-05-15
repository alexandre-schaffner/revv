import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { chatSessions } from "./chat-sessions";

/**
 * Plans the agent has presented for approval. Borrows t3code's
 * `sourceProposedPlan` pattern: when a user approves a plan, the next
 * turn-start command carries the plan id forward as `approvedPlanId` so the
 * follow-up execution turn has a record of what plan it's executing.
 *
 * Sources:
 *   - Claude: emitted on `tool_use { name: "ExitPlanMode" }` with `input.plan`
 *     as a single markdown blob. One plan per ExitPlanMode call.
 *   - Opencode: the named `plan` agent doesn't emit a structured plan
 *     delimiter — the entire assistant text for the turn IS the plan. The
 *     driver buffers all text deltas and synthesizes a single `plan-presented`
 *     event before `controller.close()`. One plan per plan-mode turn.
 *
 * The unique `(chat_session_id, turn_id)` constraint enforces "one plan per
 * turn" at the schema level — the only legitimate way to land two plans in
 * the same turn would be a driver bug, and we surface that loudly via the
 * unique-violation error.
 *
 * Status lifecycle:
 *   - 'pending'    — emitted by agent, awaiting user decision
 *   - 'approved'   — user clicked Approve. `decidedAt` is set.
 *   - 'rejected'   — user clicked Reject. `decidedAt` is set.
 *   - 'superseded' — reserved for future use if the agent re-plans mid-thread
 *                    (today we keep approved/rejected plans visible in history).
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
    // 'claude' | 'opencode'
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
