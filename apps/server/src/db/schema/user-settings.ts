import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The single settings row (`id = 'default'`). The shape, defaults and value
 * rules live in `@revv/shared` `settings.ts`; `services/Settings.ts` maps the
 * columns onto it. `scripts/revv` reads `update_channel` directly with sqlite3.
 */
export const userSettings = sqliteTable("user_settings", {
  id: text("id").primaryKey(),
  /** Retired, never read. The shipped column is NOT NULL without a default. */
  aiProvider: text("ai_provider")
    .notNull()
    .$defaultFn(() => ""),
  aiModel: text("ai_model").notNull(),
  aiThinkingEffort: text("ai_thinking_effort").notNull(),
  aiAgent: text("ai_agent").notNull(),
  aiSuggestionsModel: text("ai_suggestions_model").notNull(),
  aiMaxTurns: integer("ai_max_turns").notNull(),
  /** Retired, never read: the theme is a per-machine preference kept in localStorage. */
  theme: text("theme")
    .notNull()
    .$defaultFn(() => "dark"),
  diffViewMode: text("diff_view_mode").notNull(),
  autoFetchInterval: integer("auto_fetch_interval").notNull(),
  githubHost: text("github_host").notNull(),
  githubClientId: text("github_client_id").notNull().default(""),
  recapEnabled: integer("recap_enabled", { mode: "boolean" }).notNull(),
  recapDailyEnabled: integer("recap_daily_enabled", { mode: "boolean" }).notNull(),
  recapWeeklyEnabled: integer("recap_weekly_enabled", { mode: "boolean" }).notNull(),
  recapAgent: text("recap_agent").notNull(),
  cacheEnabled: integer("cache_enabled", { mode: "boolean" }).notNull().default(false),
  cacheBucket: text("cache_bucket").notNull().default(""),
  /** Retired, never read. */
  cacheCredentialsJson: text("cache_credentials_json").notNull().default(""),
  /** Retired, never read. */
  cacheCredentialsPath: text("cache_credentials_path").notNull().default(""),
  cacheUploadsEnabled: integer("cache_uploads_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  cacheDownloadsEnabled: integer("cache_downloads_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  updateChannel: text("update_channel").notNull().default("stable"),
  baseConflictStrategy: text("base_conflict_strategy").notNull().default("merge"),
  cacheSigningMode: text("cache_signing_mode").notNull().default("strict"),
  cacheSigningKeyPath: text("cache_signing_key_path").notNull().default(""),
  /** JSON-encoded `string[]` of trusted GitHub hosts. */
  cacheTrustedSignerHosts: text("cache_trusted_signer_hosts").notNull().default("[]"),
  // The Jev API key lives in the keyring (`secret:jev-api-key`), never here:
  // this row feeds the unauthenticated `GET /api/settings`.
  jevEnabled: integer("jev_enabled", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
