import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { newPrSessions } from "./new-pr-sessions";

/**
 * Commits made during a new-PR session, as recorded by the
 * `commit_changes` MCP tool.
 *
 * The git worktree is the source of truth for the actual ref tree —
 * `git log {branchName}` is authoritative. This table is a denormalised
 * journal so the UI can:
 *   - Render the commit list without shelling out to git on every refresh.
 *   - Keep `commit-recorded` WS deltas typed and replayable.
 *   - Detect already-committed work on resume (idempotency).
 *
 * `commit_sha` is unique per session — a re-emit of `commit_changes`
 * with the same SHA is an idempotent no-op.
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
    // JSON array of file paths touched in this commit, surfaced from
    // `git diff-tree --name-only`. Best-effort; null on tools that
    // can't enumerate.
    filesChanged: text("files_changed"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    sessionShaUnique: uniqueIndex("new_pr_commits_session_sha_unique").on(t.sessionId, t.commitSha),
    sessionIdx: index("new_pr_commits_session_idx").on(t.sessionId),
  }),
);
