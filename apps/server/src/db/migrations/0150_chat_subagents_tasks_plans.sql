-- Sub-agent / tasks / plans support for the right-pane chat.
--
-- Three new concepts surface through the chat tool surface:
--
--   • Tasks    — agent's own todo list. Claude `TodoWrite` tool, opencode
--                daemon-maintained list surfaced via `todo.updated` SSE.
--                Persisted as upsert-by-(session, task_id) rows so snapshots
--                from the agent (which carry the full list each time) settle
--                into a stable per-task sequence on first sighting.
--   • Plans    — propose-then-approve mode. Claude `permissionMode: 'plan'`
--                + `ExitPlanMode` tool, opencode named `plan` agent. Plans
--                hang on the session in `pending` status until the user
--                clicks Approve/Reject.
--   • Sub-agents — Claude `Task` tool, opencode `agent` part. Persisted so
--                  the UI can render a nested expandable card grouping the
--                  sub-agent's own tool calls (chat_activities rows stamped
--                  with subagent_invocation_id) under one header.
--
-- chat_sessions gains an `interaction_mode` column ('default' | 'plan')
-- carrying the t3code-style session-level toggle. The composer's Plan-mode
-- switch flips this; it persists across turns until the user flips it back
-- or until plan approval auto-flips it to 'default' for the execution turn.
--
-- chat_activities gains a nullable `subagent_invocation_id` FK so tool calls
-- the sub-agent emits can be visually nested under their parent invocation
-- card. ON DELETE SET NULL — dropping an invocation row doesn't cascade
-- delete the history.

-- 1. chat_sessions: add interaction_mode (default 'default').
ALTER TABLE `chat_sessions`
	ADD COLUMN `interaction_mode` TEXT NOT NULL DEFAULT 'default';
--> statement-breakpoint

-- 2. chat_activities: nullable FK to chat_subagent_invocations (created
--    below). SQLite tolerates forward references in FOREIGN KEY clauses as
--    long as the referenced table exists by the time the constraint is
--    evaluated (deferred at row insert). We add the column WITHOUT a
--    constraint here and rely on the unique index on the referenced table
--    plus the orchestrator's deterministic id to enforce integrity. The
--    cascade-on-delete semantics live in the application layer.
ALTER TABLE `chat_activities`
	ADD COLUMN `subagent_invocation_id` TEXT;
--> statement-breakpoint

-- 3. chat_tasks: per-session todo list. (chat_session_id, task_id) unique
--    so snapshot reconciliation can UPDATE existing rows in place.
CREATE TABLE `chat_tasks` (
	`id`               TEXT PRIMARY KEY NOT NULL,
	`chat_session_id`  TEXT NOT NULL REFERENCES `chat_sessions`(`id`) ON DELETE CASCADE,
	`turn_id`          TEXT NOT NULL,
	`task_id`          TEXT NOT NULL,
	`content`          TEXT NOT NULL,
	`active_form`      TEXT,
	`status`           TEXT NOT NULL,
	`priority`         TEXT,
	`source`           TEXT NOT NULL,
	`sequence`         INTEGER NOT NULL,
	`created_at`       TEXT NOT NULL,
	`updated_at`       TEXT NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_tasks_session_task_unique`
	ON `chat_tasks` (`chat_session_id`, `task_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_tasks_session_seq_unique`
	ON `chat_tasks` (`chat_session_id`, `sequence`);
--> statement-breakpoint

CREATE INDEX `chat_tasks_session_idx`
	ON `chat_tasks` (`chat_session_id`);
--> statement-breakpoint

-- 4. chat_plans: one plan per turn (enforced by unique (session, turn)).
CREATE TABLE `chat_plans` (
	`id`               TEXT PRIMARY KEY NOT NULL,
	`chat_session_id`  TEXT NOT NULL REFERENCES `chat_sessions`(`id`) ON DELETE CASCADE,
	`turn_id`          TEXT NOT NULL,
	`plan_markdown`    TEXT NOT NULL,
	`status`           TEXT NOT NULL DEFAULT 'pending',
	`source`           TEXT NOT NULL,
	`sequence`         INTEGER NOT NULL,
	`created_at`       TEXT NOT NULL,
	`decided_at`       TEXT
);
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_plans_session_turn_unique`
	ON `chat_plans` (`chat_session_id`, `turn_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_plans_session_seq_unique`
	ON `chat_plans` (`chat_session_id`, `sequence`);
--> statement-breakpoint

CREATE INDEX `chat_plans_session_idx`
	ON `chat_plans` (`chat_session_id`);
--> statement-breakpoint

-- 5. chat_subagent_invocations: nested agent calls. providerCallId is the
--    Claude tool_use.id or opencode AgentPart.id; deterministic for replays.
CREATE TABLE `chat_subagent_invocations` (
	`id`                  TEXT PRIMARY KEY NOT NULL,
	`chat_session_id`     TEXT NOT NULL REFERENCES `chat_sessions`(`id`) ON DELETE CASCADE,
	`parent_turn_id`      TEXT NOT NULL,
	`provider_call_id`    TEXT NOT NULL,
	`subagent_type`       TEXT NOT NULL,
	`description`         TEXT NOT NULL,
	`prompt`              TEXT NOT NULL,
	`status`              TEXT NOT NULL DEFAULT 'running',
	`result`              TEXT,
	`source`              TEXT NOT NULL,
	`sequence`            INTEGER NOT NULL,
	`started_at`          TEXT NOT NULL,
	`completed_at`        TEXT
);
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_subagent_invocations_session_call_unique`
	ON `chat_subagent_invocations` (`chat_session_id`, `provider_call_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_subagent_invocations_session_seq_unique`
	ON `chat_subagent_invocations` (`chat_session_id`, `sequence`);
--> statement-breakpoint

CREATE INDEX `chat_subagent_invocations_session_idx`
	ON `chat_subagent_invocations` (`chat_session_id`);
