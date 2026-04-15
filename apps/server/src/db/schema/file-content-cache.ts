import { text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';

/**
 * Cache for file contents fetched from GitHub.
 *
 * Content at a specific commit SHA + path is immutable, so entries
 * never need invalidation. The primary key encodes the triple
 * (repoFullName, path, ref) separated by NUL bytes.
 */
export const fileContentCache = sqliteTable('file_content_cache', {
	id: text('id').primaryKey(),
	content: text('content').notNull(),
	fetchedAt: text('fetched_at').notNull(),
});
