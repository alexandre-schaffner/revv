import { integer, text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { pullRequests } from './pull-requests';

/**
 * Cache for PR file diffs fetched from GitHub.
 *
 * Each row represents one file in a PR diff.
 * The primary key encodes (prId, path) separated by a NUL byte.
 * Entries are invalidated when the PR's headSha or baseSha changes.
 */
export const prDiffFiles = sqliteTable('pr_diff_files', {
	id: text('id').primaryKey(), // `${prId}\0${path}`
	prId: text('pr_id')
		.notNull()
		.references(() => pullRequests.id, { onDelete: 'cascade' }),
	path: text('path').notNull(),
	oldPath: text('old_path'),
	status: text('status').notNull(), // GitHub raw: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'unchanged'
	additions: integer('additions').notNull().default(0),
	deletions: integer('deletions').notNull().default(0),
	patch: text('patch'),
	fetchedAt: text('fetched_at').notNull(),
});
