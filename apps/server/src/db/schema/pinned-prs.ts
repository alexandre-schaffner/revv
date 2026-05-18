import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pullRequests } from "./pull-requests";
import { user } from "./auth";

/**
 * User-pinned pull requests. Each row is a (user, PR) pair with a creation
 * timestamp so pinned ordering is stable (oldest first). Deleting a row
 * unpins the PR.
 */
export const pinnedPullRequests = sqliteTable(
  "pinned_pull_requests",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    prId: text("pr_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    userPrUnique: uniqueIndex("pinned_prs_user_pr_idx").on(t.userId, t.prId),
    userIdx: uniqueIndex("pinned_prs_user_idx").on(t.userId, t.createdAt),
  }),
);
