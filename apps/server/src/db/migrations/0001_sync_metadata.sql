ALTER TABLE `comment_threads` ADD `external_thread_id` text;--> statement-breakpoint
ALTER TABLE `comment_threads` ADD `external_comment_id` text;--> statement-breakpoint
ALTER TABLE `comment_threads` ADD `last_synced_at` text;--> statement-breakpoint
ALTER TABLE `user` ADD `github_login` text;
