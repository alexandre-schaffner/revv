-- Chat feature migration: right-pane AI chat surface.
-- All chat tables FK to chat_sessions, which FKs to pull_requests
-- (created in 0000_foundation).

CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`agent` text NOT NULL,
	`session_id` text,
	`pr_head_sha` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch_name` text NOT NULL,
	`next_sequence` integer DEFAULT 0 NOT NULL,
	`interaction_mode` text DEFAULT 'default' NOT NULL,
	`created_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_sessions_pr_agent_sha_unique` ON `chat_sessions` (`pull_request_id`,`agent`,`pr_head_sha`);
--> statement-breakpoint

CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`is_streaming` integer DEFAULT 0 NOT NULL,
	`sequence` integer NOT NULL,
	`turn_id` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`finalized_at` text,
	FOREIGN KEY (`chat_session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_session_seq_unique` ON `chat_messages` (`chat_session_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `chat_messages_session_idx` ON `chat_messages` (`chat_session_id`);
--> statement-breakpoint

CREATE TABLE `chat_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`activity_kind` text NOT NULL,
	`tool_name` text,
	`summary` text NOT NULL,
	`payload_json` text,
	`sequence` integer NOT NULL,
	`subagent_invocation_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chat_session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_activities_session_seq_unique` ON `chat_activities` (`chat_session_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `chat_activities_session_idx` ON `chat_activities` (`chat_session_id`);
--> statement-breakpoint

CREATE TABLE `chat_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`task_id` text NOT NULL,
	`content` text NOT NULL,
	`active_form` text,
	`status` text NOT NULL,
	`priority` text,
	`source` text NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_tasks_session_task_unique` ON `chat_tasks` (`chat_session_id`,`task_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_tasks_session_seq_unique` ON `chat_tasks` (`chat_session_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `chat_tasks_session_idx` ON `chat_tasks` (`chat_session_id`);
--> statement-breakpoint

CREATE TABLE `chat_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`plan_markdown` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`chat_session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_plans_session_turn_unique` ON `chat_plans` (`chat_session_id`,`turn_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_plans_session_seq_unique` ON `chat_plans` (`chat_session_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `chat_plans_session_idx` ON `chat_plans` (`chat_session_id`);
--> statement-breakpoint

CREATE TABLE `chat_subagent_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_session_id` text NOT NULL,
	`parent_turn_id` text NOT NULL,
	`provider_call_id` text NOT NULL,
	`subagent_type` text NOT NULL,
	`description` text NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`result` text,
	`source` text NOT NULL,
	`sequence` integer NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`chat_session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_subagent_invocations_session_call_unique` ON `chat_subagent_invocations` (`chat_session_id`,`provider_call_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_subagent_invocations_session_seq_unique` ON `chat_subagent_invocations` (`chat_session_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `chat_subagent_invocations_session_idx` ON `chat_subagent_invocations` (`chat_session_id`);
--> statement-breakpoint

CREATE TABLE `chat_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`source` text NOT NULL,
	`provider_request_id` text NOT NULL,
	`provider_tool_call_id` text,
	`preview_format` text DEFAULT 'markdown' NOT NULL,
	`questions_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`answers_json` text,
	`custom_answers_json` text,
	`sequence` integer NOT NULL,
	`created_at` text NOT NULL,
	`answered_at` text,
	FOREIGN KEY (`chat_session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_questions_session_request_unique` ON `chat_questions` (`chat_session_id`,`provider_request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_questions_session_seq_unique` ON `chat_questions` (`chat_session_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `chat_questions_status_idx` ON `chat_questions` (`chat_session_id`,`status`);
