-- Interactive question prompts the agent surfaces to the user via the
-- right-pane chat. Distinct from `chat_plans` because multiple questions
-- can fire in one turn (each `askUserQuestion` tool call / `question.asked`
-- event), and the payload is structured rather than free-form markdown.
--
-- Sources:
--   • Claude: `tool_use { name: "askUserQuestion" }` intercepted by the
--     SDK's `canUseTool` callback. provider_request_id = tool_use.id.
--   • Opencode: `question.asked` event from the daemon's /global/event
--     stream. provider_request_id = QuestionRequest.id.
--
-- Status lifecycle: pending → answered | rejected | superseded.
-- `superseded` is set on boot for any rows left `pending` across a server
-- restart — the in-memory Claude deferred is gone, and opencode's daemon
-- state may also have been lost; the UI renders these muted.

CREATE TABLE `chat_questions` (
	`id`                       TEXT PRIMARY KEY NOT NULL,
	`chat_session_id`          TEXT NOT NULL REFERENCES `chat_sessions`(`id`) ON DELETE CASCADE,
	`turn_id`                  TEXT NOT NULL,
	`source`                   TEXT NOT NULL,
	`provider_request_id`      TEXT NOT NULL,
	`provider_tool_call_id`    TEXT,
	`preview_format`           TEXT NOT NULL DEFAULT 'markdown',
	`questions_json`           TEXT NOT NULL,
	`status`                   TEXT NOT NULL DEFAULT 'pending',
	`answers_json`             TEXT,
	`custom_answers_json`      TEXT,
	`sequence`                 INTEGER NOT NULL,
	`created_at`               TEXT NOT NULL,
	`answered_at`              TEXT
);
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_questions_session_request_unique`
	ON `chat_questions` (`chat_session_id`, `provider_request_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `chat_questions_session_seq_unique`
	ON `chat_questions` (`chat_session_id`, `sequence`);
--> statement-breakpoint

CREATE INDEX `chat_questions_status_idx`
	ON `chat_questions` (`chat_session_id`, `status`);
