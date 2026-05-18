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
  // ── Team walkthrough cache (GCS-backed) ──────────────────────────────
  // Opt-in remote cache. When `cacheEnabled` is off the feature short-
  // circuits everywhere — no probe, no upload, no download. The two
  // direction toggles let a teammate participate read-only (e.g. on a
  // flaky network, hydrate from the cache but don't push their own
  // generations) or write-only.
  cacheEnabled: integer("cache_enabled", { mode: "boolean" }).notNull().default(false),
  /** GCS bucket name. Empty string when the feature is off. */
  cacheBucket: text("cache_bucket").notNull().default(""),
  /**
   * Service-account JSON pasted directly into Settings. V1 stores this in
   * plaintext (consistent with `BETTER_AUTH_SECRET`). A future migration
   * will move it into the OS keychain via `tauri-plugin-stronghold`.
   */
  cacheCredentialsJson: text("cache_credentials_json").notNull().default(""),
  /** Alternative: filesystem path to the SA JSON file. */
  cacheCredentialsPath: text("cache_credentials_path").notNull().default(""),
  /** Allow this machine to push completed walkthroughs to the bucket. */
  cacheUploadsEnabled: integer("cache_uploads_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  /** Allow this machine to hydrate from the bucket on cache hit. */
  cacheDownloadsEnabled: integer("cache_downloads_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
