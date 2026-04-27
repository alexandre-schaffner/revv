import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  addedAt: text("added_at").notNull(),
  lastOpenedAt: text("last_opened_at"),
});
