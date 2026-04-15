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
	`added_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`ai_provider` text DEFAULT 'anthropic' NOT NULL,
	`ai_model` text DEFAULT 'claude-sonnet-4-20250514' NOT NULL,
	`ai_api_key_ref` text,
	`theme` text DEFAULT 'dark' NOT NULL,
	`diff_view_mode` text DEFAULT 'unified' NOT NULL,
	`auto_fetch_interval` integer DEFAULT 5 NOT NULL
);
