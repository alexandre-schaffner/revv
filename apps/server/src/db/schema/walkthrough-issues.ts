import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { walkthroughs } from "./walkthroughs";

export const walkthroughIssues = sqliteTable("walkthrough_issues", {
  id: text("id").primaryKey(),
  walkthroughId: text("walkthrough_id")
    .notNull()
    .references(() => walkthroughs.id, { onDelete: "cascade" }),
  order: integer("order").notNull(),
  severity: text("severity").notNull(), // 'info' | 'warning' | 'critical'
  title: text("title").notNull(),
  description: text("description").notNull(),
  filePath: text("file_path"),
  startLine: integer("start_line"),
  endLine: integer("end_line"),
  blockIds: text("block_ids").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  // ISO 8601 timestamp recorded when the reviewer posts this issue to GitHub
  // via the Request Changes flow. Null = not yet sent. Used to persist the
  // "already submitted" treatment (grayed-out, unselectable) across sessions.
  submittedAt: text("submitted_at"),
  // ── Orchestrator advisory scoring (Jev) ───────────────────────────────
  // Local judgments: deliberately excluded from `exportWalkthroughSnapshot`
  // so they never enter the transport-stable cache payload.
  /** Composite signal score in [0,1]. Null = never scored. */
  advisoryScore: real("advisory_score"),
  /** ISO 8601 timestamp of the scoring pass that wrote `advisoryScore`. */
  advisoryScoredAt: text("advisory_scored_at"),
});
