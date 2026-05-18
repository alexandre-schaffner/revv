ALTER TABLE `user_settings` ADD `cache_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_settings` ADD `cache_bucket` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_settings` ADD `cache_credentials_json` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_settings` ADD `cache_credentials_path` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_settings` ADD `cache_uploads_enabled` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_settings` ADD `cache_downloads_enabled` integer DEFAULT 1 NOT NULL;
