import type { StackMergeRunLayer } from "@revv/shared";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { repositories } from "./repositories";

export const stackMergeRuns = sqliteTable(
  "stack_merge_runs",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    stackNumber: integer("stack_number").notNull(),
    throughPosition: integer("through_position").notNull(),
    method: text("method", { enum: ["merge", "squash", "rebase"] }).notNull(),
    mode: text("mode", { enum: ["auto", "driven"] }).notNull(),
    status: text("status", {
      enum: ["running", "waiting", "complete", "failed", "cancelled", "expired"],
    }).notNull(),
    layersBaseFirst: text("layers", { mode: "json" }).$type<StackMergeRunLayer[]>().notNull(),
    error: text("error"),
    accountId: text("account_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("stack_merge_runs_stack_idx").on(t.repositoryId, t.stackNumber)],
);
