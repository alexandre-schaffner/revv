-- Project recap feature migration.
-- One table with self-referencing supersession, keyed on (repository, period, start).

CREATE TABLE `project_recaps` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`period` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
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
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`superseded_by`) REFERENCES `project_recaps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_recaps_repo_period_start_idx` ON `project_recaps` (`repository_id`,`period`,`period_start`);
--> statement-breakpoint
CREATE INDEX `project_recaps_status_idx` ON `project_recaps` (`status`);
