CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `file_content_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`fetched_at` text NOT NULL
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
CREATE TABLE `pr_diff_files` (
	`id` text PRIMARY KEY NOT NULL,
	`pr_id` text NOT NULL,
	`path` text NOT NULL,
	`old_path` text,
	`status` text NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`patch` text,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` integer NOT NULL,
	`repository_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`author_login` text NOT NULL,
	`author_avatar_url` text,
	`status` text DEFAULT 'open' NOT NULL,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`source_branch` text NOT NULL,
	`target_branch` text NOT NULL,
	`url` text NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`changed_files` integer DEFAULT 0 NOT NULL,
	`head_sha` text,
	`base_sha` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`avatar_url` text,
	`added_at` text NOT NULL,
	`clone_status` text DEFAULT 'pending' NOT NULL,
	`clone_path` text,
	`clone_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repositories_full_name` ON `repositories` (`full_name`);--> statement-breakpoint
CREATE TABLE `review_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`ai_provider` text DEFAULT 'anthropic' NOT NULL,
	`ai_model` text DEFAULT 'opencode/big-pickle' NOT NULL,
	`theme` text DEFAULT 'dark' NOT NULL,
	`diff_view_mode` text DEFAULT 'unified' NOT NULL,
	`auto_fetch_interval` integer DEFAULT 5 NOT NULL,
	`ai_thinking_effort` text DEFAULT 'medium' NOT NULL,
	`ai_agent` text DEFAULT 'opencode' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `walkthrough_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`walkthrough_id` text NOT NULL,
	`order` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`walkthrough_id`) REFERENCES `walkthroughs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `walkthrough_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`walkthrough_id` text NOT NULL,
	`order` integer NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`file_path` text,
	`start_line` integer,
	`end_line` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`walkthrough_id`) REFERENCES `walkthroughs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `walkthroughs` (
	`id` text PRIMARY KEY NOT NULL,
	`review_session_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	`summary` text NOT NULL,
	`risk_level` text DEFAULT 'low' NOT NULL,
	`status` text DEFAULT 'generating' NOT NULL,
	`generated_at` text NOT NULL,
	`model_used` text NOT NULL,
	`token_usage` text DEFAULT '{}' NOT NULL,
	`pr_head_sha` text NOT NULL,
	FOREIGN KEY (`review_session_id`) REFERENCES `review_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
