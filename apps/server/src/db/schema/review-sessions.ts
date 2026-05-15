import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pullRequests } from "./pull-requests";

export const reviewSessions = sqliteTable("review_sessions", {
  id: text("id").primaryKey(),
  pullRequestId: text("pull_request_id")
    .notNull()
    .references(() => pullRequests.id, { onDelete: "cascade" }),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull().default("active"),
});
