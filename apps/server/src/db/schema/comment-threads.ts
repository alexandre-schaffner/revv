import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { reviewSessions } from "./review-sessions";
import { walkthroughIssues } from "./walkthrough-issues";

export const commentThreads = sqliteTable("comment_threads", {
  id: text("id").primaryKey(),
  reviewSessionId: text("review_session_id")
    .notNull()
    .references(() => reviewSessions.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  diffSide: text("diff_side").notNull().default("new"),
  status: text("status").notNull().default("open"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
  externalThreadId: text("external_thread_id"),
  externalCommentId: text("external_comment_id"),
  lastSyncedAt: text("last_synced_at"),
  // A status set in Revv that GitHub hasn't taken yet: a pull keeps it and
  // pushes it again rather than reverting it to GitHub's.
  statusPushPending: integer("status_push_pending", { mode: "boolean" }).notNull().default(false),
  // The walkthrough issue this thread comments on, when the agent wrote it
  // (`add_issue_comment`); null for human threads, and for an AI thread already
  // on GitHub whose issue went away (`threadWrites.retireAiThreads` detaches it
  // before the issue is deleted).
  walkthroughIssueId: text("walkthrough_issue_id").references(() => walkthroughIssues.id, {
    onDelete: "cascade",
  }),
});
