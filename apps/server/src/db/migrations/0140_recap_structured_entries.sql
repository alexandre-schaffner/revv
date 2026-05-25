ALTER TABLE `project_recaps` ADD COLUMN `lede` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `project_recaps` ADD COLUMN `total_lines_added` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `project_recaps` ADD COLUMN `total_lines_removed` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `recap_pr_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`recap_id` text NOT NULL,
	`pr_id` text NOT NULL,
	`position` integer NOT NULL,
	`theme` text NOT NULL,
	`verb` text NOT NULL,
	`pr_title` text DEFAULT '' NOT NULL,
	`pr_external_id` integer DEFAULT 0 NOT NULL,
	`pr_author_login` text DEFAULT '' NOT NULL,
	`description` text NOT NULL,
	`lines_added` integer DEFAULT 0 NOT NULL,
	`lines_removed` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`recap_id`) REFERENCES `project_recaps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recap_pr_entries_recap_pr_unique_idx` ON `recap_pr_entries` (`recap_id`,`pr_id`);
--> statement-breakpoint
CREATE INDEX `recap_pr_entries_recap_position_idx` ON `recap_pr_entries` (`recap_id`,`position`);
