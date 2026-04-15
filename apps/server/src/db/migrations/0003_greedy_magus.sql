CREATE TABLE `comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`review_session_id` text NOT NULL,
	`file_path` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`diff_side` text DEFAULT 'new' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`review_session_id`) REFERENCES `review_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `hunk_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`review_session_id` text NOT NULL,
	`file_path` text NOT NULL,
	`hunk_index` integer NOT NULL,
	`decision` text NOT NULL,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`review_session_id`) REFERENCES `review_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_hunk_session_file_index` ON `hunk_decisions` (`review_session_id`,`file_path`,`hunk_index`);--> statement-breakpoint
CREATE TABLE `review_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `thread_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`author_role` text DEFAULT 'reviewer' NOT NULL,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`message_type` text DEFAULT 'comment' NOT NULL,
	`code_suggestion` text,
	`created_at` text NOT NULL,
	`edited_at` text,
	`external_id` text,
	FOREIGN KEY (`thread_id`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
