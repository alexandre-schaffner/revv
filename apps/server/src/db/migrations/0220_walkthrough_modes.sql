ALTER TABLE `walkthroughs` ADD `mode` text DEFAULT 'reviewer' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `walkthroughs_pr_head_sha_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `walkthroughs_pr_head_sha_mode_unique` ON `walkthroughs` (`pull_request_id`,`pr_head_sha`,`mode`);
