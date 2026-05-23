CREATE TABLE `recap_theme_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`recap_id` text NOT NULL,
	`theme` text NOT NULL,
	`summary` text NOT NULL,
	FOREIGN KEY (`recap_id`) REFERENCES `project_recaps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recap_theme_summaries_recap_theme_unique_idx` ON `recap_theme_summaries` (`recap_id`,`theme`);
--> statement-breakpoint
CREATE INDEX `recap_theme_summaries_recap_idx` ON `recap_theme_summaries` (`recap_id`);
