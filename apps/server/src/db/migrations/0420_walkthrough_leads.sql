CREATE TABLE `walkthrough_leads` (
	`id` text PRIMARY KEY NOT NULL,
	`walkthrough_id` text NOT NULL,
	`lead_key` text NOT NULL,
	`ordinal` integer NOT NULL,
	`file_path` text NOT NULL,
	`hunk_index` integer NOT NULL,
	`new_start` integer NOT NULL,
	`new_lines` integer NOT NULL,
	`smells` text NOT NULL,
	`verdict` text,
	`issue_id` text,
	`reason` text,
	`resolved_at` text,
	FOREIGN KEY (`walkthrough_id`) REFERENCES `walkthroughs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `walkthrough_issues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_walkthrough_leads_wt_key` ON `walkthrough_leads` (`walkthrough_id`,`lead_key`);--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `leads_selected_at` text;