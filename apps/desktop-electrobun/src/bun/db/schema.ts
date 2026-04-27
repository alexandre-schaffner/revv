import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceTable = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  branch: text("branch"),
  worktreeCount: integer("worktree_count"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
});
