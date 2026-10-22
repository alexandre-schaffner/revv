-- Scope chat ACP sessions by model as well as provider.
ALTER TABLE `chat_sessions` ADD `model` text DEFAULT '' NOT NULL;
--> statement-breakpoint
DROP INDEX `chat_sessions_pr_agent_sha_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_sessions_pr_agent_model_sha_unique` ON `chat_sessions` (`pull_request_id`,`agent`,`model`,`pr_head_sha`);
