CREATE TABLE `stack_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`stack_number` integer NOT NULL,
	`pr_id` text NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`status` text NOT NULL,
	`layers` text NOT NULL,
	`started` integer DEFAULT 0 NOT NULL,
	`awaiting` text NOT NULL,
	`deadline_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stack_reviews_stack_idx` ON `stack_reviews` (`repository_id`,`stack_number`,`status`);--> statement-breakpoint
ALTER TABLE `project_recaps` ADD `source_bundle` text;--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `end_reason` text;--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `launch_plan` text;--> statement-breakpoint
-- A user's Stop was recorded only as this message; it is now the row's end reason.
UPDATE `walkthroughs` SET `end_reason` = 'cancelled'
WHERE `status` = 'error' AND `error_message` = 'Walkthrough cancelled';
