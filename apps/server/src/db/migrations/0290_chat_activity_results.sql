ALTER TABLE `chat_activities` ADD `call_id` text;--> statement-breakpoint
ALTER TABLE `chat_activities` ADD `output` text;--> statement-breakpoint
ALTER TABLE `chat_activities` ADD `is_error` integer;--> statement-breakpoint
CREATE INDEX `chat_activities_session_call_idx` ON `chat_activities` (`chat_session_id`,`call_id`);
