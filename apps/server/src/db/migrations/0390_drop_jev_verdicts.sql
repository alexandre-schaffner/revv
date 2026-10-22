ALTER TABLE `user_settings` DROP COLUMN `jev_verdicts`;--> statement-breakpoint
ALTER TABLE `walkthrough_ratings` DROP COLUMN `verdict_source`;--> statement-breakpoint
ALTER TABLE `walkthrough_ratings` DROP COLUMN `verdict_confidence`;--> statement-breakpoint
ALTER TABLE `walkthrough_ratings` DROP COLUMN `disputed`;--> statement-breakpoint
ALTER TABLE `walkthroughs` DROP COLUMN `axis_advisory_state`;