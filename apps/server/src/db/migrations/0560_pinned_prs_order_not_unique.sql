DROP INDEX `pinned_prs_user_idx`;--> statement-breakpoint
CREATE INDEX `pinned_prs_user_idx` ON `pinned_pull_requests` (`user_id`,`created_at`);