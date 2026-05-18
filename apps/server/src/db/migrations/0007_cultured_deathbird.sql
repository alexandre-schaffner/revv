CREATE TABLE `pinned_pull_requests` (
	`user_id` text NOT NULL,
	`pr_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pinned_prs_user_pr_idx` ON `pinned_pull_requests` (`user_id`,`pr_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pinned_prs_user_idx` ON `pinned_pull_requests` (`user_id`,`created_at`);
