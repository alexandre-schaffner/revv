ALTER TABLE `user_settings` ADD `jev_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `jev_auto_model` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `jev_risk` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `jev_verdicts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `jev_issue_scoring` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `jev_hide_low_signal` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `jev_adjudicate_continuations` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `risk_confidence` real;--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `axis_advisory_state` text;--> statement-breakpoint
ALTER TABLE `walkthrough_ratings` ADD `verdict_source` text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE `walkthrough_ratings` ADD `verdict_confidence` real;--> statement-breakpoint
ALTER TABLE `walkthrough_ratings` ADD `disputed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `walkthrough_issues` ADD `advisory_score` real;--> statement-breakpoint
ALTER TABLE `walkthrough_issues` ADD `advisory_scored_at` text;
