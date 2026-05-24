CREATE TABLE `github_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` integer NOT NULL,
	`node_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`state` text DEFAULT 'open' NOT NULL,
	`author_login` text NOT NULL,
	`author_avatar_url` text,
	`assignee_logins` text DEFAULT '[]' NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `github_issues_repo_state_updated_idx` ON `github_issues` (`repository_id`,`state`,`updated_at`);
