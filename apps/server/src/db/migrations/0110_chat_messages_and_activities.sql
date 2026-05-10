-- Chat persistence: A1 (messages) + C1 (structured activities) from the
-- Tier-1 gap-analysis roadmap.
--
-- Until now the right-pane chat held the transcript only in Svelte runes +
-- the agent's own session storage (Claude SDK JSONL or opencode daemon).
-- Closing the desktop app, restarting the daemon, or moving across devices
-- lost the visible history. This migration moves the transcript into SQLite
-- so it survives the agent's session-storage churn.
--
-- Schema additions:
--   - chat_messages   — one row per user/assistant turn. Streaming partial
--                       bodies persist with is_streaming = 1 until finalized.
--   - chat_activities — typed tool-use rows replacing the opaque
--                       {kind: 'tool', data: string} SSE frame. Carries
--                       activity_kind + tool_name + payload_json so the UI
--                       can render rich items and future approvals can attach.
--
-- Both tables FK to chat_sessions.id (the row's own UUID — the durable
-- thread identity). chat_sessions.session_id (the agent-side session UUID)
-- is now nullable: the chat route creates the chat_sessions row eagerly when
-- the user sends their first message so messages can FK to it BEFORE the
-- agent emits its own session id. The id arrives via the existing
-- onSessionId callback and is patched in.
--
-- Sequence numbers are per-session monotonic, allocated atomically against
-- chat_sessions.next_sequence so messages and activities share one ordering
-- space (matches t3code's projection_thread_messages/activities pattern).
-- Without a shared space the UI can't reliably interleave activity rows
-- between user and assistant turns.

-- 1. Recreate chat_sessions with session_id NULLABLE + next_sequence column.
--    SQLite can't ALTER COLUMN to drop NOT NULL, so we copy through a new table.
CREATE TABLE `chat_sessions_new` (
	`id`                TEXT PRIMARY KEY NOT NULL,
	`pull_request_id`   TEXT NOT NULL REFERENCES `pull_requests`(`id`) ON DELETE CASCADE,
	`agent`             TEXT NOT NULL,
	`session_id`        TEXT,
	`pr_head_sha`       TEXT NOT NULL,
	`worktree_path`     TEXT NOT NULL,
	`branch_name`       TEXT NOT NULL,
	`next_sequence`     INTEGER NOT NULL DEFAULT 0,
	`created_at`        TEXT NOT NULL,
	`last_activity_at`  TEXT NOT NULL
);
--> statement-breakpoint

INSERT INTO `chat_sessions_new`
	(`id`, `pull_request_id`, `agent`, `session_id`, `pr_head_sha`,
	 `worktree_path`, `branch_name`, `next_sequence`, `created_at`, `last_activity_at`)
SELECT
	`id`, `pull_request_id`, `agent`, `session_id`, `pr_head_sha`,
	`worktree_path`, `branch_name`, 0, `created_at`, `last_activity_at`
FROM `chat_sessions`;
--> statement-breakpoint

DROP TABLE `chat_sessions`;
--> statement-breakpoint

ALTER TABLE `chat_sessions_new` RENAME TO `chat_sessions`;
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_sessions_pr_agent_sha_unique`
	ON `chat_sessions` (`pull_request_id`, `agent`, `pr_head_sha`);
--> statement-breakpoint

-- 2. chat_messages. One row per user or assistant turn-body.
--    Assistant rows use is_streaming = 1 while the agent is mid-stream so the
--    UI can render the typing indicator from DB state alone.
CREATE TABLE `chat_messages` (
	`id`              TEXT PRIMARY KEY NOT NULL,
	`chat_session_id` TEXT NOT NULL REFERENCES `chat_sessions`(`id`) ON DELETE CASCADE,
	`role`            TEXT NOT NULL,
	`content`         TEXT NOT NULL DEFAULT '',
	`is_streaming`    INTEGER NOT NULL DEFAULT 0,
	`sequence`        INTEGER NOT NULL,
	`turn_id`         TEXT NOT NULL,
	`error`           TEXT,
	`created_at`      TEXT NOT NULL,
	`finalized_at`    TEXT
);
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_messages_session_seq_unique`
	ON `chat_messages` (`chat_session_id`, `sequence`);
--> statement-breakpoint

CREATE INDEX `chat_messages_session_idx`
	ON `chat_messages` (`chat_session_id`);
--> statement-breakpoint

-- 3. chat_activities. Typed tool-use rows.
--    activity_kind uses a controlled vocabulary ('tool.read', 'tool.bash',
--    'tool.mcp', etc.) — the UI can pick an icon + style off it. The raw
--    provider tool name is preserved in tool_name for debugging.
CREATE TABLE `chat_activities` (
	`id`              TEXT PRIMARY KEY NOT NULL,
	`chat_session_id` TEXT NOT NULL REFERENCES `chat_sessions`(`id`) ON DELETE CASCADE,
	`turn_id`         TEXT NOT NULL,
	`activity_kind`   TEXT NOT NULL,
	`tool_name`       TEXT,
	`summary`         TEXT NOT NULL,
	`payload_json`    TEXT,
	`sequence`        INTEGER NOT NULL,
	`created_at`      TEXT NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_activities_session_seq_unique`
	ON `chat_activities` (`chat_session_id`, `sequence`);
--> statement-breakpoint

CREATE INDEX `chat_activities_session_idx`
	ON `chat_activities` (`chat_session_id`);
