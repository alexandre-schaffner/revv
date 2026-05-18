CREATE TABLE `new_pr_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`activity_kind` text NOT NULL,
	`tool_name` text,
	`summary` text NOT NULL,
	`payload_json` text,
	`sequence` integer NOT NULL,
	`subagent_invocation_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `new_pr_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `new_pr_activities_session_seq_unique` ON `new_pr_activities` (`session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `new_pr_activities_session_idx` ON `new_pr_activities` (`session_id`);--> statement-breakpoint
CREATE TABLE `new_pr_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`message` text NOT NULL,
	`files_changed` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `new_pr_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `new_pr_commits_session_sha_unique` ON `new_pr_commits` (`session_id`,`commit_sha`);--> statement-breakpoint
CREATE INDEX `new_pr_commits_session_idx` ON `new_pr_commits` (`session_id`);--> statement-breakpoint
CREATE TABLE `new_pr_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`is_streaming` integer DEFAULT 0 NOT NULL,
	`sequence` integer NOT NULL,
	`turn_id` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`finalized_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `new_pr_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `new_pr_messages_session_seq_unique` ON `new_pr_messages` (`session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `new_pr_messages_session_idx` ON `new_pr_messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `new_pr_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`user_id` text NOT NULL,
	`agent` text NOT NULL,
	`session_id` text,
	`base_sha` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch_name` text NOT NULL,
	`title` text,
	`body` text,
	`pr_external_id` integer,
	`pr_id` text,
	`status` text DEFAULT 'chatting' NOT NULL,
	`next_sequence` integer DEFAULT 0 NOT NULL,
	`resume_attempts` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`interaction_mode` text DEFAULT 'default' NOT NULL,
	`created_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `new_pr_sessions_status_idx` ON `new_pr_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `new_pr_sessions_user_repo_idx` ON `new_pr_sessions` (`user_id`,`repository_id`,`created_at`);