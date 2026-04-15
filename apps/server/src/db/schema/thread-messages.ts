import { text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { commentThreads } from './comment-threads';

export const threadMessages = sqliteTable('thread_messages', {
	id: text('id').primaryKey(),
	threadId: text('thread_id')
		.notNull()
		.references(() => commentThreads.id, { onDelete: 'cascade' }),
	authorRole: text('author_role').notNull().default('reviewer'),
	authorName: text('author_name').notNull(),
	body: text('body').notNull(),
	messageType: text('message_type').notNull().default('comment'),
	codeSuggestion: text('code_suggestion'),
	createdAt: text('created_at').notNull(),
	editedAt: text('edited_at'),
	externalId: text('external_id'),
});
