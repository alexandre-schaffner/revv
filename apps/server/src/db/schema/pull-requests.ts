import { integer, text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { repositories } from './repositories';

export const pullRequests = sqliteTable('pull_requests', {
	id: text('id').primaryKey(),
	externalId: integer('external_id').notNull(),
	repositoryId: text('repository_id')
		.notNull()
		.references(() => repositories.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	body: text('body'),
	authorLogin: text('author_login').notNull(),
	authorAvatarUrl: text('author_avatar_url'),
	status: text('status').notNull().default('open'),
	reviewStatus: text('review_status').notNull().default('pending'),
	sourceBranch: text('source_branch').notNull(),
	targetBranch: text('target_branch').notNull(),
	url: text('url').notNull(),
	additions: integer('additions').notNull().default(0),
	deletions: integer('deletions').notNull().default(0),
	changedFiles: integer('changed_files').notNull().default(0),
	createdAt: text('created_at').notNull(),
	updatedAt: text('updated_at').notNull(),
	fetchedAt: text('fetched_at').notNull(),
});
