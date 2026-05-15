import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Generic key/value cache for small metadata blobs — the durable backing store
 * behind {@link CacheService}.
 *
 * - `ns` groups related keys (e.g. `github:repos`, `github:user`) so a whole
 *   namespace can be invalidated in one statement.
 * - `value_json` is a JSON-serialized payload; large binaries belong elsewhere.
 * - `expires_at` is null for immutable entries (keyed on `headSha` / `ref`), set
 *   to a future ISO-8601 timestamp for TTL entries.
 * - `etag` is optional metadata for callers who want to thread conditional-
 *   request semantics through this table (rare — most REST ETagging lives in
 *   `github_etag_cache` instead).
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
