-- Foundation migration: auth, core domain, caches.
-- One clean CREATE TABLE per entity in final schema — no ALTER TABLE backfill
-- noise. Tables are ordered so foreign-key targets precede their dependents.

-- ── Auth & identity ───────────────────────────────────────────

CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`github_login` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`onboarded_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);
--> statement-breakpoint

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
	`github_login` text,
	`avatar_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
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
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);
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

-- ── Repositories & pull requests ──────────────────────────────

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
	`clone_error` text,
	`github_host` text DEFAULT 'nocturlab.ghe.com' NOT NULL,
	`account_id` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repositories_full_name_account` ON `repositories` (`full_name`,`account_id`);
--> statement-breakpoint

CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` integer NOT NULL,
	`repository_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`author_login` text NOT NULL,
	`author_avatar_url` text,
	`requested_reviewers` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
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
	`closed_at` text,
	`comments_synced_at` text,
	`threads_fingerprint` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_requests_repo_closed_at_idx` ON `pull_requests` (`repository_id`,`closed_at`);
--> statement-breakpoint

-- ── Review sessions & decisions ───────────────────────────────

CREATE TABLE `review_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
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
CREATE UNIQUE INDEX `uq_hunk_session_file_index` ON `hunk_decisions` (`review_session_id`,`file_path`,`hunk_index`);
--> statement-breakpoint

-- ── Caches & misc ─────────────────────────────────────────────

CREATE TABLE `cache_entries` (
	`ns` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`etag` text,
	`last_modified` text,
	`tag_json` text,
	`fetched_at` text NOT NULL,
	`expires_at` text,
	`approx_bytes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`ns`, `key`)
);
--> statement-breakpoint
CREATE INDEX `cache_entries_expires_at_idx` ON `cache_entries` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `cache_entries_ns_fetched_at_idx` ON `cache_entries` (`ns`,`fetched_at`);
--> statement-breakpoint

CREATE TABLE `file_content_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint

CREATE TABLE `github_etag_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`etag` text NOT NULL,
	`last_modified` text,
	`body_json` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint

CREATE TABLE `kv_cache` (
	`ns` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`etag` text,
	`fetched_at` text NOT NULL,
	`expires_at` text,
	PRIMARY KEY(`ns`, `key`)
);
--> statement-breakpoint

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
