CREATE TABLE `stack_brief_layers` (
	`id` text PRIMARY KEY NOT NULL,
	`brief_id` text NOT NULL,
	`position` integer NOT NULL,
	`pr_number` integer NOT NULL,
	`role` text NOT NULL,
	`review_focus` text NOT NULL,
	`chapter` text NOT NULL,
	`builds_on` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`brief_id`) REFERENCES `stack_briefs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stack_brief_layers_brief_position_unique` ON `stack_brief_layers` (`brief_id`,`position`);--> statement-breakpoint
CREATE TABLE `stack_briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`stack_number` integer NOT NULL,
	`signature` text NOT NULL,
	`stack_snapshot` text NOT NULL,
	`status` text DEFAULT 'generating' NOT NULL,
	`last_completed_phase` text DEFAULT 'none' NOT NULL,
	`arc` text DEFAULT '' NOT NULL,
	`review_order` text DEFAULT '[]' NOT NULL,
	`resume_attempts` integer DEFAULT 0 NOT NULL,
	`superseded_by` text,
	`error_message` text,
	`model_used` text,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`superseded_by`) REFERENCES `stack_briefs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stack_briefs_active_signature_unique` ON `stack_briefs` (`repository_id`,`stack_number`,`signature`) WHERE "stack_briefs"."status" <> 'superseded';--> statement-breakpoint
CREATE INDEX `stack_briefs_stack_idx` ON `stack_briefs` (`repository_id`,`stack_number`);--> statement-breakpoint
CREATE TABLE `stack_merge_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`stack_number` integer NOT NULL,
	`through_position` integer NOT NULL,
	`method` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`layers` text NOT NULL,
	`error` text,
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stack_merge_runs_stack_idx` ON `stack_merge_runs` (`repository_id`,`stack_number`);--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `stack_context` text;--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `diff_fingerprint` text;--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `carried_from_walkthrough_id` text;