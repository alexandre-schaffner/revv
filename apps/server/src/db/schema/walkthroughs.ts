import { integer, text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { reviewSessions } from './review-sessions';
import { pullRequests } from './pull-requests';

export const walkthroughs = sqliteTable('walkthroughs', {
	id: text('id').primaryKey(),
	reviewSessionId: text('review_session_id')
		.notNull()
		.references(() => reviewSessions.id, { onDelete: 'cascade' }),
	pullRequestId: text('pull_request_id')
		.notNull()
		.references(() => pullRequests.id, { onDelete: 'cascade' }),
	summary: text('summary').notNull(),
	riskLevel: text('risk_level').notNull().default('low'),
	status: text('status').notNull().default('generating'), // 'generating' | 'complete' | 'error'
	generatedAt: text('generated_at').notNull(),
	modelUsed: text('model_used').notNull(),
	tokenUsage: text('token_usage').notNull().default('{}'),
	prHeadSha: text('pr_head_sha').notNull(),
	opencodeSessionId: text('opencode_session_id'),
	// Incremented each time WalkthroughJobs.resumePending() picks this row back up
	// after a server restart. Capped at WALKTHROUGH_MAX_RESUME_ATTEMPTS before the
	// row is marked `error` and left alone.
	resumeAttempts: integer('resume_attempts').notNull().default(0),
});
