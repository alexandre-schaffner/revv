import { text } from 'drizzle-orm/sqlite-core';
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
});
