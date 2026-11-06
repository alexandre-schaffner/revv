import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pullRequests } from "./pull-requests";

/**
 * A pull request's review: what its comment threads, walkthroughs and review
 * rounds hang off. A PR has one conversation on GitHub, so it has one review,
 * whoever is looking at it.
 */
export const reviewSessions = sqliteTable(
  "review_sessions",
  {
    id: text("id").primaryKey(),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    startedAt: text("started_at").notNull(),
  },
  (t) => ({
    prUnique: uniqueIndex("review_sessions_pull_request_id_unique").on(t.pullRequestId),
  }),
);
