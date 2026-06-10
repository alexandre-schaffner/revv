import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pullRequests } from "./pull-requests";

export const reviewSessions = sqliteTable(
  "review_sessions",
  {
    id: text("id").primaryKey(),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    mode: text("mode").notNull().default("reviewer"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    status: text("status").notNull().default("active"),
  },
  (t) => ({
    prModeStatusIdx: index("review_sessions_pr_mode_status_idx").on(
      t.pullRequestId,
      t.mode,
      t.status,
    ),
  }),
);
