CREATE TABLE `external_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_external_integrations_provider_account` ON `external_integrations` (`provider`,`account_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_external_integrations_token_hash` ON `external_integrations` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `external_integrations_account_idx` ON `external_integrations` (`account_id`);
--> statement-breakpoint
ALTER TABLE `walkthrough_issues` ADD `resolution_status` text DEFAULT 'open' NOT NULL;
--> statement-breakpoint
ALTER TABLE `walkthrough_issues` ADD `resolution_explanation` text;
--> statement-breakpoint
ALTER TABLE `walkthrough_issues` ADD `resolution_evidence` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `walkthrough_issues` ADD `resolving_commit_sha` text;
--> statement-breakpoint
ALTER TABLE `walkthrough_issues` ADD `resolved_at` text;
--> statement-breakpoint
ALTER TABLE `walkthrough_issues` ADD `resolved_by` text;
