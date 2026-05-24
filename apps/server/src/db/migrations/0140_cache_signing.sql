ALTER TABLE `user_settings` ADD `cache_signing_mode` text DEFAULT 'strict' NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_settings` ADD `cache_signing_key_path` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `user_settings` ADD `cache_trusted_signer_hosts` text DEFAULT '[]' NOT NULL;
