-- Backfill the ALTER statements that were silently skipped by 0100_remote_users.sql.
-- The original migration grouped four statements under a single statement chunk
-- (missing `--> statement-breakpoint` separators), and Bun's SQLite driver only
-- executes the first statement of a multi-statement chunk via `db.run`. As a
-- result, `user.identity_id`, `thread_messages.author_login`, and the
-- `pull_requests.author_avatar_url` drop never landed on dev databases even
-- though 0100 is recorded as applied.
--
-- This migration is safe to run on fresh installs too: on a fresh DB, 0100 will
-- still only apply its first chunk and the `CREATE UNIQUE INDEX` from the
-- second chunk, then 0140 here finishes the job.

ALTER TABLE `user` ADD `identity_id` text REFERENCES `remote_users`(`id`);
--> statement-breakpoint
ALTER TABLE `thread_messages` ADD `author_login` text;
--> statement-breakpoint
ALTER TABLE `pull_requests` DROP COLUMN `author_avatar_url`;
