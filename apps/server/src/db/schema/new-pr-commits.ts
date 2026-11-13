import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { newPrSessions } from "./new-pr-sessions";

/**
 * Retired: nothing reads or writes this table. It stays in users' databases
 * (no drop migration) and stays declared here because the migration snapshot
 * still lists it, so `drizzle-kit generate` would otherwise emit a DROP TABLE.
 */
export const newPrCommits = sqliteTable(
  "new_pr_commits",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => newPrSessions.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    message: text("message").notNull(),
    filesChanged: text("files_changed"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    sessionShaUnique: uniqueIndex("new_pr_commits_session_sha_unique").on(t.sessionId, t.commitSha),
    sessionIdx: index("new_pr_commits_session_idx").on(t.sessionId),
  }),
);
