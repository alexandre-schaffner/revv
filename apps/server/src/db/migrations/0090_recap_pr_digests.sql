CREATE TABLE `recap_pr_digests` (
	`id` text PRIMARY KEY NOT NULL,
	`recap_id` text NOT NULL,
	`pr_id` text NOT NULL,
	`source` text NOT NULL,
	`digest` text NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`note` text,
	`generated_at` text NOT NULL,
	FOREIGN KEY (`recap_id`) REFERENCES `project_recaps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recap_pr_digests_recap_pr_unique_idx` ON `recap_pr_digests` (`recap_id`,`pr_id`);
--> statement-breakpoint
CREATE INDEX `recap_pr_digests_recap_idx` ON `recap_pr_digests` (`recap_id`);
