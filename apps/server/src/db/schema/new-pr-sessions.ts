import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { pullRequests } from "./pull-requests";
import { repositories } from "./repositories";

/**
 * Retired: nothing reads or writes this table. It stays in users' databases
 * (no drop migration) and stays declared here because the migration snapshot
 * still lists it, so `drizzle-kit generate` would otherwise emit a DROP TABLE.
 */
export const newPrSessions = sqliteTable(
  "new_pr_sessions",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    sessionId: text("session_id"),
    baseSha: text("base_sha").notNull(),
    worktreePath: text("worktree_path").notNull(),
    branchName: text("branch_name").notNull(),
    title: text("title"),
    body: text("body"),
    prExternalId: integer("pr_external_id"),
    prId: text("pr_id").references(() => pullRequests.id, { onDelete: "set null" }),
    status: text("status").notNull().default("chatting"),
    nextSequence: integer("next_sequence").notNull().default(0),
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    errorMessage: text("error_message"),
    interactionMode: text("interaction_mode").notNull().default("default"),
    createdAt: text("created_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => ({
    statusIdx: index("new_pr_sessions_status_idx").on(t.status),
    userRepoIdx: index("new_pr_sessions_user_repo_idx").on(t.userId, t.repositoryId, t.createdAt),
  }),
);
