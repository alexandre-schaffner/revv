import { integer, text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';

export const userSettings = sqliteTable('user_settings', {
	id: text('id').primaryKey().default('default'),
	aiProvider: text('ai_provider').notNull().default('anthropic'),
	aiModel: text('ai_model').notNull().default('claude-sonnet-4-20250514'),
	aiApiKeyRef: text('ai_api_key_ref'),
	theme: text('theme').notNull().default('dark'),
	diffViewMode: text('diff_view_mode').notNull().default('unified'),
	autoFetchInterval: integer('auto_fetch_interval').notNull().default(5),
});
