import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * User preferences — migrated from `~/.revv/settings.json`.
 * Single-user app, so exactly one row with `id = 'default'`.
 */
export const userSettings = sqliteTable("user_settings", {
  id: text("id").primaryKey(),
  aiProvider: text("ai_provider").notNull(),
  aiModel: text("ai_model").notNull(),
  aiThinkingEffort: text("ai_thinking_effort").notNull(),
  aiAgent: text("ai_agent").notNull(),
  aiContextWindow: text("ai_context_window").notNull(),
  aiSuggestionsModel: text("ai_suggestions_model").notNull(),
  aiMaxTurns: integer("ai_max_turns").notNull(),
  theme: text("theme").notNull(),
  diffViewMode: text("diff_view_mode").notNull(),
  autoFetchInterval: integer("auto_fetch_interval").notNull(),
  githubHost: text("github_host").notNull(),
  // recap sub-object flattened to individual columns
  recapEnabled: integer("recap_enabled", { mode: "boolean" }).notNull(),
  recapDailyEnabled: integer("recap_daily_enabled", { mode: "boolean" }).notNull(),
  recapWeeklyEnabled: integer("recap_weekly_enabled", { mode: "boolean" }).notNull(),
  recapAgent: text("recap_agent").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
