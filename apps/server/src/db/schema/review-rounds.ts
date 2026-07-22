import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pullRequests } from "./pull-requests";
import { reviewSessions } from "./review-sessions";
import { walkthroughs } from "./walkthroughs";

/**
 * Durable timeline of review attempts for a PR.
 *
 * The walkthrough remains the visible report artifact. Review rounds are the
 * hidden history/control-plane layer: they record which SHA range was reviewed,
 * which walkthrough artifact resulted, and whether the row should be surfaced
 * in future history UI.
 */
export const reviewRounds = sqliteTable(
  "review_rounds",
  {
    id: text("id").primaryKey(),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    reviewSessionId: text("review_session_id")
      .notNull()
      .references(() => reviewSessions.id, { onDelete: "cascade" }),
    walkthroughId: text("walkthrough_id")
      .notNull()
      .references(() => walkthroughs.id, { onDelete: "cascade" }),
    previousWalkthroughId: text("previous_walkthrough_id").references(() => walkthroughs.id, {
      onDelete: "set null",
    }),
    roundNumber: integer("round_number").notNull(),
    kind: text("kind").notNull().default("full"),
    visibility: text("visibility").notNull().default("visible"),
    status: text("status").notNull().default("generating"),
    fromSha: text("from_sha"),
    toSha: text("to_sha").notNull(),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => ({
    prRoundIdx: index("review_rounds_pr_round_idx").on(t.pullRequestId, t.roundNumber),
    walkthroughIdx: index("review_rounds_walkthrough_idx").on(t.walkthroughId),
  }),
);
