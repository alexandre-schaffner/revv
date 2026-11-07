import {
  MERGE_METHODS,
  STACK_MERGE_MODES,
  STACK_MERGE_RUN_STATUSES,
  type StackMergeRunLayer,
} from "@revv/shared";
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
    method: text("method", { enum: MERGE_METHODS }).notNull(),
    mode: text("mode", { enum: STACK_MERGE_MODES }).notNull(),
    status: text("status", { enum: STACK_MERGE_RUN_STATUSES }).notNull(),
    layersBaseFirst: text("layers", { mode: "json" }).$type<StackMergeRunLayer[]>().notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("stack_merge_runs_stack_idx").on(t.repositoryId, t.stackNumber)],
);
