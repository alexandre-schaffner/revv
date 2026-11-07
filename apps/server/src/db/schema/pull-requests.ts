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
    isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(false),
    sourceBranch: text("source_branch").notNull(),
    targetBranch: text("target_branch").notNull(),
    url: text("url").notNull(),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    changedFiles: integer("changed_files").notNull().default(0),
    /**
     * Head SHA for which additions/deletions/changedFiles came from the
     * GraphQL stats endpoint. Distinguishes a real 0/0/0 from the list endpoint's placeholder.
     */
    diffStatsHeadSha: text("diff_stats_head_sha"),
    /** Retired: never written or read. */
    diffFilesCachedCount: integer("diff_files_cached_count"),
    /**
     * The `head_sha` and `base_sha` this row held when the fetch behind the
     * cached `pr_diff_files` rows started. Written only by
     * `DiffCacheService.cacheDiff`, with the rows. The rows are this PR's
     * diff only while both still equal `head_sha` and `base_sha`; a null
     * `diff_files_head_sha` (never stamped, or fetched while the head was
     * unknown) never matches.
     */
    diffFilesHeadSha: text("diff_files_head_sha"),
    diffFilesBaseSha: text("diff_files_base_sha"),
    /**
     * The PR's commits for the same range as the cached `pr_diff_files`
     * rows, as JSON `PrCommit[]` head first, written with them. Null on
     * diffs cached before commits were, which read as not cached.
     */
    diffCommits: text("diff_commits"),
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
     * Fingerprint of the PR's GitHub review threads as of the last GraphQL
     * thread pull (`fingerprintThreads` in `services/Sync.ts`). A change marks
     * the PR changed even when no row was written: a resolve, a thread vanishing.
     */
    threadsFingerprint: text("threads_fingerprint"),
    /**
     * JSON array of GitHub logins mentioned via @-mention in the PR body
     * or review comments. Populated incrementally during sync — append-only,
     * never pruned. Used by the repo homepage to surface PRs the user is
     * "tagged on" even when not a requested reviewer.
     */
    mentionedUsers: text("mentioned_users").notNull().default("[]"),
    /**
     * GitHub's native stack this PR belongs to (`PullRequest.stack.number`)
     * and its place in it (`stackEntry.position`, 1 sits on the base branch).
     * Null when the PR isn't stacked, or the host predates stacks.
     */
    stackNumber: integer("stack_number"),
    stackPosition: integer("stack_position"),
  },
  (t) => ({
    /**
     * The windowed archive read: closed/merged PRs of a repo in [since, until],
     * for the recap pipeline and the sidebar's archive listing.
     */
    repoClosedAtIdx: index("pull_requests_repo_closed_at_idx").on(t.repositoryId, t.closedAt),
  }),
);
