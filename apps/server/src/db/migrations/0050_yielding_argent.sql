CREATE TABLE `user_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`ai_provider` text NOT NULL,
	`ai_model` text NOT NULL,
	`ai_thinking_effort` text NOT NULL,
	`ai_agent` text NOT NULL,
	`ai_context_window` text NOT NULL,
	`ai_suggestions_model` text NOT NULL,
	`ai_max_turns` integer NOT NULL,
	`theme` text NOT NULL,
	`diff_view_mode` text NOT NULL,
	`auto_fetch_interval` integer NOT NULL,
	`github_host` text NOT NULL,
	`recap_enabled` integer NOT NULL,
	`recap_daily_enabled` integer NOT NULL,
	`recap_weekly_enabled` integer NOT NULL,
	`recap_agent` text NOT NULL,
	`updated_at` integer NOT NULL
);
