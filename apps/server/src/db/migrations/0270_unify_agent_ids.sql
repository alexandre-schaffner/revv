-- Collapse the dual agent-id model onto the single ACP registry id space.
-- Chat used `chat_agent` (an ACP registry id: claude-code/opencode/codex/cursor);
-- walkthrough + recap used the legacy `ai_agent` enum (claude/opencode/codex).
-- Unify on the registry id: prefer the more specific `chat_agent` when set, then
-- map the legacy `claude` value onto its registry id, then drop `chat_agent`.
UPDATE `user_settings` SET `ai_agent` = `chat_agent` WHERE `chat_agent` != '';
--> statement-breakpoint
UPDATE `user_settings` SET `ai_agent` = 'claude-code' WHERE `ai_agent` = 'claude';
--> statement-breakpoint
UPDATE `user_settings` SET `recap_agent` = 'claude-code' WHERE `recap_agent` = 'claude';
--> statement-breakpoint
ALTER TABLE `user_settings` DROP COLUMN `chat_agent`;
