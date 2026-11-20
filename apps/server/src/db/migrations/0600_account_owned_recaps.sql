-- Preserve recap content while SQLite rebuilds the parent table with foreign keys enabled.
CREATE TABLE `__account_recap_backup_project_recaps` AS SELECT * FROM `project_recaps`;
--> statement-breakpoint
CREATE TABLE `__account_recap_backup_recap_pr_entries` AS SELECT * FROM `recap_pr_entries`;
--> statement-breakpoint
CREATE TABLE `__account_recap_backup_recap_theme_summaries` AS SELECT * FROM `recap_theme_summaries`;
--> statement-breakpoint
CREATE TABLE `__account_recap_backup_recap_pr_digests` AS SELECT * FROM `recap_pr_digests`;
--> statement-breakpoint
DROP TABLE `project_recaps`;
--> statement-breakpoint
CREATE TABLE `project_recaps` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`account_id` text,
	`scope_key` text DEFAULT '' NOT NULL,
	`source_scope` text,
	`period` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`lede` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'generating' NOT NULL,
	`superseded_by` text,
	`generated_at` text NOT NULL,
	`completed_at` text,
	`model_used` text,
	`token_usage` text DEFAULT '{}' NOT NULL,
	`source_pr_ids` text DEFAULT '[]' NOT NULL,
	`source_walkthrough_ids` text DEFAULT '[]' NOT NULL,
	`summary_stats` text DEFAULT '{}' NOT NULL,
	`resume_attempts` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`source_bundle` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`superseded_by`) REFERENCES `project_recaps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `project_recaps` ("id", "repository_id", "account_id", "scope_key", "source_scope", "period", "period_start", "period_end", "lede", "status", "superseded_by", "generated_at", "completed_at", "model_used", "token_usage", "source_pr_ids", "source_walkthrough_ids", "summary_stats", "resume_attempts", "error_message", "source_bundle") SELECT "id", CASE WHEN scope_key != '' AND source_scope IS NOT NULL THEN NULL ELSE repository_id END, CASE WHEN scope_key != '' AND source_scope IS NOT NULL THEN COALESCE((SELECT account_id FROM repositories WHERE repositories.id = source.repository_id), json_extract(source_scope, '$.accountId')) ELSE NULL END, "scope_key", "source_scope", "period", "period_start", "period_end", "lede", "status", "superseded_by", "generated_at", "completed_at", "model_used", "token_usage", "source_pr_ids", "source_walkthrough_ids", "summary_stats", "resume_attempts", "error_message", "source_bundle" FROM `__account_recap_backup_project_recaps` AS source;
--> statement-breakpoint
INSERT INTO `recap_pr_entries` SELECT * FROM `__account_recap_backup_recap_pr_entries`;
--> statement-breakpoint
INSERT INTO `recap_theme_summaries` SELECT * FROM `__account_recap_backup_recap_theme_summaries`;
--> statement-breakpoint
INSERT INTO `recap_pr_digests` SELECT * FROM `__account_recap_backup_recap_pr_digests`;
--> statement-breakpoint
DROP TABLE `__account_recap_backup_project_recaps`;
--> statement-breakpoint
DROP TABLE `__account_recap_backup_recap_pr_entries`;
--> statement-breakpoint
DROP TABLE `__account_recap_backup_recap_theme_summaries`;
--> statement-breakpoint
DROP TABLE `__account_recap_backup_recap_pr_digests`;
--> statement-breakpoint
CREATE INDEX `project_recaps_repo_period_start_idx` ON `project_recaps` (`repository_id`,`period`,`period_start`);--> statement-breakpoint
CREATE INDEX `project_recaps_status_idx` ON `project_recaps` (`status`);--> statement-breakpoint
CREATE INDEX `project_recaps_scope_period_start_idx` ON `project_recaps` (`scope_key`,`period`,`period_start`);
