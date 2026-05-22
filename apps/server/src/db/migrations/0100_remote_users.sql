-- Create the remote_users table for canonical user profiles
CREATE TABLE `remote_users` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_user_id` text NOT NULL,
	`login` text NOT NULL,
	`display_name` text,
	`avatar_content` text,
	`last_fetched_at` integer,
	`last_avatar_url` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_users_provider_id_idx` ON `remote_users` (`provider`,`provider_user_id`);
--> statement-breakpoint
-- Add identity_id to user table (FK to remote_users)
ALTER TABLE `user` ADD `identity_id` text REFERENCES `remote_users`(`id`);
--> statement-breakpoint
-- Add author_login to thread_messages (no FK - existing rows won't have matches)
ALTER TABLE `thread_messages` ADD `author_login` text;
--> statement-breakpoint
-- Drop author_avatar_url from pull_requests (avatar now resolved from remote_users)
ALTER TABLE `pull_requests` DROP COLUMN `author_avatar_url`;
