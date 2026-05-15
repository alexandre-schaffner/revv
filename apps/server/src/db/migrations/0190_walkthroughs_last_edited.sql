-- Track post-completion chat-edit mutations on walkthrough rows (CLAUDE.md
-- invariant #7 carve-out). Null until a chat-edit MCP tool first mutates the
-- row; thereafter `last_edited_at` is an ISO 8601 timestamp and
-- `last_edited_by` is the actor (e.g. `chat:claude` / `chat:opencode`). The
-- generation pipeline never writes either column.
ALTER TABLE `walkthroughs` ADD COLUMN `last_edited_at` text;
--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD COLUMN `last_edited_by` text;
