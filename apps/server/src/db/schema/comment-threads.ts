import { integer, text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { reviewSessions } from './review-sessions';

export const commentThreads = sqliteTable('comment_threads', {
	id: text('id').primaryKey(),
	reviewSessionId: text('review_session_id')
		.notNull()
		.references(() => reviewSessions.id, { onDelete: 'cascade' }),
	filePath: text('file_path').notNull(),
	startLine: integer('start_line').notNull(),
	endLine: integer('end_line').notNull(),
	diffSide: text('diff_side').notNull().default('new'),
	status: text('status').notNull().default('open'),
	createdAt: text('created_at').notNull(),
	resolvedAt: text('resolved_at'),
});
