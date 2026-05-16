-- Walkthrough & review-comment feature migration.
-- All walkthrough tables plus comment_threads / thread_messages, which FK to
-- walkthrough_issues and therefore must live in this group.

-- ── Walkthroughs ──────────────────────────────────────────────

CREATE TABLE `walkthroughs` (
	`id` text PRIMARY KEY NOT NULL,
	`review_session_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`risk_level` text DEFAULT 'low' NOT NULL,
	`sentiment` text,
	`status` text DEFAULT 'generating' NOT NULL,
	`last_completed_phase` text DEFAULT 'none' NOT NULL,
	`superseded_by` text,
	`generated_at` text NOT NULL,
	`completed_at` text,
	`model_used` text NOT NULL,
	`token_usage` text DEFAULT '{}' NOT NULL,
	`pr_head_sha` text NOT NULL,
	`opencode_session_id` text,
	`resume_attempts` integer DEFAULT 0 NOT NULL,
	`last_edited_at` text,
	`last_edited_by` text,
	`pr_commits` text,
	FOREIGN KEY (`review_session_id`) REFERENCES `review_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`superseded_by`) REFERENCES `walkthroughs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `walkthroughs_pr_head_sha_unique` ON `walkthroughs` (`pull_request_id`,`pr_head_sha`);
--> statement-breakpoint

CREATE TABLE `walkthrough_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`walkthrough_id` text NOT NULL,
	`phase` text DEFAULT 'diff_analysis' NOT NULL,
	`semantic_step_index` integer NOT NULL,
	`order` integer NOT NULL,
	`step_index` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`walkthrough_id`) REFERENCES `walkthroughs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `walkthrough_blocks_phase_step_unique` ON `walkthrough_blocks` (`walkthrough_id`,`phase`,`semantic_step_index`,`step_index`);
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
	`block_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`submitted_at` text,
	FOREIGN KEY (`walkthrough_id`) REFERENCES `walkthroughs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `walkthrough_ratings` (
	`id` text PRIMARY KEY NOT NULL,
	`walkthrough_id` text NOT NULL,
	`axis` text NOT NULL,
	`verdict` text NOT NULL,
	`confidence` text NOT NULL,
	`rationale` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`citations` text DEFAULT '[]' NOT NULL,
	`block_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`walkthrough_id`) REFERENCES `walkthroughs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `walkthrough_ratings_wt_axis_unique` ON `walkthrough_ratings` (`walkthrough_id`,`axis`);
--> statement-breakpoint

CREATE TABLE `walkthrough_semantic_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`walkthrough_id` text NOT NULL,
	`semantic_step_index` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`walkthrough_id`) REFERENCES `walkthroughs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `walkthrough_semantic_steps_unique` ON `walkthrough_semantic_steps` (`walkthrough_id`,`semantic_step_index`);
--> statement-breakpoint

-- ── Review comments (depend on walkthrough_issues) ────────────

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
	`external_thread_id` text,
	`external_comment_id` text,
	`last_synced_at` text,
	`walkthrough_issue_id` text,
	FOREIGN KEY (`review_session_id`) REFERENCES `review_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`walkthrough_issue_id`) REFERENCES `walkthrough_issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `thread_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`author_role` text DEFAULT 'reviewer' NOT NULL,
	`author_name` text NOT NULL,
	`author_avatar_url` text,
	`body` text NOT NULL,
	`message_type` text DEFAULT 'comment' NOT NULL,
	`code_suggestion` text,
	`created_at` text NOT NULL,
	`edited_at` text,
	`external_id` text,
	FOREIGN KEY (`thread_id`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
