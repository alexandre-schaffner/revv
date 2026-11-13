import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The durable backing store behind {@link CacheService}, for small metadata
 * blobs. `expires_at` is null for immutable entries (keyed on `headSha` /
 * `ref`), else an ISO-8601 timestamp. `etag` is unused: REST ETags live in
 * `github_etag_cache`.
 */
export const kvCache = sqliteTable(
  "kv_cache",
  {
    ns: text("ns").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    etag: text("etag"),
    fetchedAt: text("fetched_at").notNull(),
    expiresAt: text("expires_at"),
  },
  (table) => [primaryKey({ columns: [table.ns, table.key] })],
);
