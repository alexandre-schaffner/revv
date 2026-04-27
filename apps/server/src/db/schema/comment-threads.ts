import { integer, text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { reviewSessions } from './review-sessions';
import { walkthroughIssues } from './walkthrough-issues';

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
	externalThreadId: text('external_thread_id'),
	externalCommentId: text('external_comment_id'),
	lastSyncedAt: text('last_synced_at'),
	// Optional back-reference to a walkthrough_issues row when this thread was
	// authored by the AI agent via the `add_issue_comment` MCP tool. Null for
	// every human-authored thread. Lets us trace AI comments to their source
	// issue and (via the cascading walkthrough_issues → walkthroughs FK chain)
	// drop AI comments cleanly when the underlying walkthrough is superseded.
	walkthroughIssueId: text('walkthrough_issue_id').references(
		() => walkthroughIssues.id,
		{ onDelete: 'cascade' },
	),
});
