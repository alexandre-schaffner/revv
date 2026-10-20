import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { repositories } from "./repositories";

/**
 * One "merge this stack through layer N" the user confirmed. Persisted because
 * the intent is outward and destructive: a merge Revv is halfway through must
 * be visible (and continuable) after a restart, never silently replayed.
 *
 * GitHub stays authoritative for what actually merged. `StackMergeService`
 * advances a run by re-reading the stack from GitHub before every step, so a
 * step is idempotent and a run picks up wherever GitHub says it is. Every
 * merge is pinned to the head in `layers[].expectedHeadSha`: a layer that got
 * new commits after the user confirmed is never merged.
 *
 * Status: `running` / `waiting` (for GitHub to retarget or recompute the next
 * layer) → `complete` | `failed` | `cancelled`; a run still `running` or
 * `waiting` long after its last step is `expired` on boot, with a Continue
 * action, rather than resumed behind the user's back.
 */
export const stackMergeRuns = sqliteTable(
  "stack_merge_runs",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    stackNumber: integer("stack_number").notNull(),
    /** The highest position to merge, inclusive. */
    throughPosition: integer("through_position").notNull(),
    /** `MergeMethod`. */
    method: text("method").notNull(),
    /** `StackMergeMode`: `auto` hands the upper layers to GitHub's auto-merge. */
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    /** JSON `StackMergeRunLayer[]`, base first. */
    layers: text("layers").notNull(),
    error: text("error"),
    /** The account whose token runs the merges. */
    accountId: text("account_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("stack_merge_runs_stack_idx").on(t.repositoryId, t.stackNumber)],
);
