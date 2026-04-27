import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { repositories } from "./repositories";

export const pullRequests = sqliteTable("pull_requests", {
  id: text("id").primaryKey(),
  externalId: integer("external_id").notNull(),
  repositoryId: text("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body"),
  authorLogin: text("author_login").notNull(),
  authorAvatarUrl: text("author_avatar_url"),
  requestedReviewers: text("requested_reviewers").notNull().default("[]"),
  status: text("status").notNull().default("open"),
  reviewStatus: text("review_status").notNull().default("pending"),
  sourceBranch: text("source_branch").notNull(),
  targetBranch: text("target_branch").notNull(),
  url: text("url").notNull(),
  additions: integer("additions").notNull().default(0),
  deletions: integer("deletions").notNull().default(0),
  changedFiles: integer("changed_files").notNull().default(0),
  headSha: text("head_sha"),
  baseSha: text("base_sha"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  /**
   * High-water-mark timestamp of the latest review comment we've ingested
   * from GitHub for this PR. Passed as `?since=…` on the next poll so
   * `listReviewComments` only returns comments newer than this — large
   * bandwidth saving for active PRs. Null = sync from the beginning.
   */
  commentsSyncedAt: text("comments_synced_at"),
  /**
   * sha256(sorted(threadNodeId + lastCommentUpdatedAt)) — computed after each
   * GraphQL thread pull. If unchanged on the next tick, skip all downstream
   * DB writes and WS events for this PR (Phase 3 optimization; stored now so
   * migrations don't need to change again).
   */
  threadsFingerprint: text("threads_fingerprint"),
});
