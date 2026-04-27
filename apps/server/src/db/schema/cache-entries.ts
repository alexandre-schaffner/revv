import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Consolidated durable cache — the SQLite backend behind the unified
 * {@link CacheLayer} abstraction.
 *
 * Replaces a growing fleet of per-concern tables (`kv_cache`,
 * `github_etag_cache`, and — eventually — `file_content_cache`) with a
 * single row schema that every freshness policy can use:
 *
 * - `ns`/`key` — the canonical namespace + opaque keyed string.
 * - `value_json` — JSON-serialized payload.
 * - `etag` / `last_modified` — HTTP conditional-request headers captured
 *   from upstream; used by {@link EtagPolicy}.
 * - `tag_json` — opaque metadata the policy threads through
 *   (e.g. `headSha` for SHA-keyed entries, query hash for GraphQL).
 * - `fetched_at` — when this row was last refreshed (even for 304s).
 * - `expires_at` — nullable; TTL policies set a future ISO-8601 timestamp,
 *   SHA/immutable/watermark policies leave null.
 * - `approx_bytes` — pre-computed size for namespace-level quota checks
 *   without a `LENGTH(value_json)` scan.
 *
 * Pre-existing tables (`kv_cache`, etc.) continue to work in parallel
 * until M7, when a backfill migration unifies them in here and drops them.
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
