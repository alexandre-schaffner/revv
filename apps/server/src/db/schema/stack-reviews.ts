import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { repositories } from "./repositories";

export interface StackReviewLayer {
  readonly number: number;
  readonly prId: string;
}

/**
 * One "review the stack" request: its layers' walkthroughs are queued a few at
 * a time, and once they settle the stack brief is asked for. Journaled so a
 * restart picks the review up where it was rather than dropping the queue and
 * the brief.
 */
export const stackReviews = sqliteTable(
  "stack_reviews",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    stackNumber: integer("stack_number").notNull(),
    /** The PR the review was asked from; the brief is asked for through it. */
    prId: text("pr_id").notNull(),
    userId: text("user_id").notNull(),
    accountId: text("account_id").notNull(),
    status: text("status", { enum: ["running", "done", "abandoned"] }).notNull(),
    /** The layers to review, base first. */
    layers: text("layers", { mode: "json" }).$type<StackReviewLayer[]>().notNull(),
    /** How many of `layers` have been started. */
    started: integer("started").notNull().default(0),
    /** Walkthroughs the brief waits on: those this review started, and those already generating when it began. */
    awaiting: text("awaiting", { mode: "json" }).$type<string[]>().notNull(),
    deadlineAt: text("deadline_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("stack_reviews_stack_idx").on(t.repositoryId, t.stackNumber, t.status)],
);
