import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Retired: nothing reads or writes this table. It stays in users' databases
 * (no drop migration) and stays declared here because the migration snapshot
 * still lists it, so `drizzle-kit generate` would otherwise emit a DROP TABLE.
 */
export const cacheEntries = sqliteTable(
  "cache_entries",
  {
    ns: text("ns").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    etag: text("etag"),
    lastModified: text("last_modified"),
    tagJson: text("tag_json"),
    fetchedAt: text("fetched_at").notNull(),
    expiresAt: text("expires_at"),
    approxBytes: integer("approx_bytes").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.ns, table.key] }),
    index("cache_entries_expires_at_idx").on(table.expiresAt),
    index("cache_entries_ns_fetched_at_idx").on(table.ns, table.fetchedAt),
  ],
);
