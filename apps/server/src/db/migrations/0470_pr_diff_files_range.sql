ALTER TABLE `pull_requests` ADD `diff_files_head_sha` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `diff_files_base_sha` text;--> statement-breakpoint
CREATE INDEX `pr_diff_files_pr_id_idx` ON `pr_diff_files` (`pr_id`);