import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { pullRequests } from "./pull-requests";

/** A (user, PR) pair; `created_at` keeps pinned ordering stable (oldest first). */
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
    userIdx: index("pinned_prs_user_idx").on(t.userId, t.createdAt),
  }),
);
