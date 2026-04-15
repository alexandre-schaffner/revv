import { text } from 'drizzle-orm/sqlite-core';
import { sqliteTable, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const repositories = sqliteTable(
	'repositories',
	{
		id: text('id').primaryKey(),
		provider: text('provider').notNull().default('github'),
		owner: text('owner').notNull(),
		name: text('name').notNull(),
		fullName: text('full_name').notNull(),
		defaultBranch: text('default_branch').notNull().default('main'),
		avatarUrl: text('avatar_url'),
		addedAt: text('added_at').notNull(),
	},
	(table) => [uniqueIndex('uq_repositories_full_name').on(table.fullName)]
);
