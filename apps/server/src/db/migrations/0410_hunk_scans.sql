CREATE TABLE `hunk_scan_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`file_path` text NOT NULL,
	`hunk_index` integer NOT NULL,
	`old_start` integer NOT NULL,
	`old_lines` integer NOT NULL,
	`new_start` integer NOT NULL,
	`new_lines` integer NOT NULL,
	`content_hash` text NOT NULL,
	`skip_reason` text,
	`signals` text,
	`scanned_at` text,
	FOREIGN KEY (`scan_id`) REFERENCES `hunk_scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_hunk_scan_rows_scan_file_hunk` ON `hunk_scan_rows` (`scan_id`,`file_path`,`hunk_index`);--> statement-breakpoint
CREATE TABLE `hunk_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`pr_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_hunk_scans_pr_head` ON `hunk_scans` (`pr_id`,`head_sha`);