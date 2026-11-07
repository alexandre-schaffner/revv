import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Retired: nothing reads or writes this table. It stays in users' databases
 * (no drop migration) and stays declared here because the migration snapshot
 * still lists it, so `drizzle-kit generate` would otherwise emit a DROP TABLE.
 */
export const fileContentCache = sqliteTable("file_content_cache", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  fetchedAt: text("fetched_at").notNull(),
});
