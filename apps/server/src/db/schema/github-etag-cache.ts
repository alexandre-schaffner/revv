import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * ETag cache for GitHub REST responses.
 *
 * Keyed by sha256(method + path + sortedQuery). Each entry stores the last
 * successful response body + the ETag header we got with it. On the next
 * call, we send `If-None-Match: <etag>` and, on a 304, replay the stored
 * body for zero rate-limit cost.
 *
 * Not used for GraphQL (GitHub's GraphQL endpoint does not advertise ETags).
 */
export const githubEtagCache = sqliteTable("github_etag_cache", {
  cacheKey: text("cache_key").primaryKey(),
  etag: text("etag").notNull(),
  lastModified: text("last_modified"),
  bodyJson: text("body_json").notNull(),
  fetchedAt: text("fetched_at").notNull(),
});
