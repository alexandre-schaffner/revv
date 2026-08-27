import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { repositories } from "./repositories";

export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: text("id").primaryKey(),
    externalId: integer("external_id").notNull(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body"),
    authorLogin: text("author_login").notNull(),
    requestedReviewers: text("requested_reviewers").notNull().default("[]"),
    status: text("status").notNull().default("open"),
    reviewStatus: text("review_status").notNull().default("pending"),
    isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(false),
    sourceBranch: text("source_branch").notNull(),
    targetBranch: text("target_branch").notNull(),
    url: text("url").notNull(),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    changedFiles: integer("changed_files").notNull().default(0),
    /**
     * How many `pr_diff_files` rows the last complete GitHub files fetch
     * produced for this PR. Written only by `DiffCacheService.cacheFiles`, in
     * the same transaction as the rows themselves, and cleared when the cache
     * is invalidated.
     *
     * Deliberately separate from `changed_files`. That column is GitHub's own
     * stat and counts file *entries*, which exceeds the number of distinct
     * paths whenever a file's type changed (GitHub reports one `removed` and
     * one `added` entry for the same path). `pr_diff_files` is keyed on
     * `(prId, path)`, so the cached row count for such a PR can never reach
     * `changed_files` — and the completeness guard, comparing the two, made
     * every single page view re-fetch all 30 pages from GitHub. This column is
     * the honest signal: "the cache holds everything the last fetch returned."
     * Null on rows written before this column existed, and on rows whose diff
     * cache was invalidated; both fall back to the `changed_files` comparison
     * and self-heal after one fetch.
     */
    diffFilesCachedCount: integer("diff_files_cached_count"),
    headSha: text("head_sha"),
    baseSha: text("base_sha"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    closedAt: text("closed_at"),
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
     * DB writes and SSE events for this PR (Phase 3 optimization; stored now so
     * migrations don't need to change again).
     */
    threadsFingerprint: text("threads_fingerprint"),
    /**
     * JSON array of GitHub logins mentioned via @-mention in the PR body
     * or review comments. Populated incrementally during sync — append-only,
     * never pruned. Used by the repo homepage to surface PRs the user is
     * "tagged on" even when not a requested reviewer.
     */
    mentionedUsers: text("mentioned_users").notNull().default("[]"),
  },
  (t) => ({
    /**
     * Composite index for the windowed archive read path: "give me closed/merged
     * PRs for repo R in [since, until]". Without this the recap pipeline's
     * scheduler scans the entire pull_requests table on every period boundary
     * check, and the sidebar's archive listing degrades as the table grows.
     */
    repoClosedAtIdx: index("pull_requests_repo_closed_at_idx").on(t.repositoryId, t.closedAt),
  }),
);
