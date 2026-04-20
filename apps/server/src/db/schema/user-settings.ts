import { integer, text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';

export const userSettings = sqliteTable('user_settings', {
	id: text('id').primaryKey().default('default'),
	aiProvider: text('ai_provider').notNull().default('anthropic'),
	aiModel: text('ai_model').notNull().default('opencode/big-pickle'),
	theme: text('theme').notNull().default('dark'),
	diffViewMode: text('diff_view_mode').notNull().default('unified'),
	autoFetchInterval: integer('auto_fetch_interval').notNull().default(5),
	aiThinkingEffort: text('ai_thinking_effort').notNull().default('medium'),
	aiAgent: text('ai_agent').notNull().default('opencode'),
	aiContextWindow: text('ai_context_window').notNull().default('200k'),
	// Boolean stored as integer 0/1 (SQLite convention). When 1, the updater
	// downloads + installs new versions silently and then prompts for a
	// restart; when 0 (default) the user is asked before installing. See
	// `apps/web/src/lib/updater/service.ts`.
	autoInstallUpdates: integer('auto_install_updates').notNull().default(0),
});
