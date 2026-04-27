-- Right-pane AI chat: per-(PR, agent, head_sha) session mapping.
--
-- Each row is the durable handle for a live agent conversation:
--   - session_id   → the agent-side session UUID (claude SDK or opencode daemon)
--   - worktree_path→ chat-{pr_id}-{sha12} worktree, the agent's cwd
--   - branch_name  → revv-chat/{pr_id}-{sha12} branch the agent commits to
--
-- See `apps/server/src/db/schema/chat-sessions.ts` for the full doctrine note.
-- A new commit on the PR ⇒ different pr_head_sha ⇒ unique key changes ⇒ a
-- fresh row, fresh worktree, fresh branch. Old rows are released by the
-- chat route on stale-sibling detection.

CREATE TABLE IF NOT EXISTS `chat_sessions` (
	`id`                TEXT PRIMARY KEY NOT NULL,
	`pull_request_id`   TEXT NOT NULL REFERENCES `pull_requests`(`id`) ON DELETE CASCADE,
	`agent`             TEXT NOT NULL,
	`session_id`        TEXT NOT NULL,
	`pr_head_sha`       TEXT NOT NULL,
	`worktree_path`     TEXT NOT NULL,
	`branch_name`       TEXT NOT NULL,
	`created_at`        TEXT NOT NULL,
	`last_activity_at`  TEXT NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `chat_sessions_pr_agent_sha_unique`
	ON `chat_sessions` (`pull_request_id`, `agent`, `pr_head_sha`);
--> statement-breakpoint

-- Drop the legacy explanation cache. The right-pane explanation feature has
-- been replaced by the chat surface; the table is no longer read or written.
DROP TABLE IF EXISTS `ai_explanations`;
