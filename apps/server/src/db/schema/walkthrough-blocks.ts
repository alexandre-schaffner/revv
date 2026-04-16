import { integer, text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { walkthroughs } from './walkthroughs';

export const walkthroughBlocks = sqliteTable('walkthrough_blocks', {
	id: text('id').primaryKey(),
	walkthroughId: text('walkthrough_id')
		.notNull()
		.references(() => walkthroughs.id, { onDelete: 'cascade' }),
	order: integer('order').notNull(),
	type: text('type').notNull(),
	data: text('data').notNull(), // JSON of the full WalkthroughBlock
	createdAt: text('created_at').notNull(),
});
