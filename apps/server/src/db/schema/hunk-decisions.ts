import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { reviewSessions } from "./review-sessions";

export const hunkDecisions = sqliteTable(
  "hunk_decisions",
  {
    id: text("id").primaryKey(),
    reviewSessionId: text("review_session_id")
      .notNull()
      .references(() => reviewSessions.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    hunkIndex: integer("hunk_index").notNull(),
    decision: text("decision").notNull(),
    decidedAt: text("decided_at").notNull(),
  },
  (table) => [
    unique("uq_hunk_session_file_index").on(
      table.reviewSessionId,
      table.filePath,
      table.hunkIndex,
    ),
  ],
);
