ALTER TABLE `stack_brief_layers` ADD `chapter` text;--> statement-breakpoint
ALTER TABLE `stack_brief_layers` ADD `builds_on` text DEFAULT '[]' NOT NULL;