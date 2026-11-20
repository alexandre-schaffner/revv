ALTER TABLE `project_recaps` ADD `scope_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `project_recaps` ADD `source_scope` text;--> statement-breakpoint
CREATE INDEX `project_recaps_scope_period_start_idx` ON `project_recaps` (`scope_key`,`period`,`period_start`);--> statement-breakpoint
ALTER TABLE `recap_pr_entries` ADD `repository_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `recap_theme_summaries` ADD `context` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `recap_theme_summaries` ADD `approach` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `recap_theme_summaries` ADD `current_state` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `recap_theme_summaries` ADD `worth_watching` text DEFAULT '' NOT NULL;