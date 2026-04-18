CREATE TABLE IF NOT EXISTS `cache_entries` (
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
CREATE INDEX IF NOT EXISTS `cache_entries_expires_at_idx` ON `cache_entries` (`expires_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cache_entries_ns_fetched_at_idx` ON `cache_entries` (`ns`, `fetched_at`);
