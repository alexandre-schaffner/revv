ALTER TABLE `walkthroughs` ADD `generated_by_github_user_id` integer;
--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `generated_by_github_login` text;
--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `generated_by_display_name` text;
--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `generated_by_avatar_url` text;
--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `provider_config` text;
