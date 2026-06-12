ALTER TABLE `review_sessions` ADD `mode` text DEFAULT 'reviewer' NOT NULL;
--> statement-breakpoint
CREATE INDEX `review_sessions_pr_mode_status_idx` ON `review_sessions` (`pull_request_id`,`mode`,`status`);
