-- Daily / weekly project recap table. See db/schema/project-recaps.ts for
-- the column documentation; this migration just creates the row shape.
--
-- One row per (repository, period, period_start), with supersession on
-- regenerate. Status / lifecycle columns mirror the walkthrough table so
-- the orchestrator (ProjectRecapJobs) can reuse the resume-on-boot,
-- bounded-retry, and single-writer-status patterns from WalkthroughJobs.

CREATE TABLE IF NOT EXISTS `project_recaps` (
  `id` text PRIMARY KEY NOT NULL,
  `repository_id` text NOT NULL REFERENCES `repositories`(`id`) ON DELETE CASCADE,
  `period` text NOT NULL,
  `period_start` text NOT NULL,
  `period_end` text NOT NULL,
  `overview` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT 'generating',
  `superseded_by` text REFERENCES `project_recaps`(`id`) ON DELETE SET NULL,
  `generated_at` text NOT NULL,
  `completed_at` text,
  `model_used` text,
  `token_usage` text NOT NULL DEFAULT '{}',
  `source_pr_ids` text NOT NULL DEFAULT '[]',
  `source_walkthrough_ids` text NOT NULL DEFAULT '[]',
  `summary_stats` text NOT NULL DEFAULT '{}',
  `resume_attempts` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `project_recaps_repo_period_start_idx`
  ON `project_recaps` (`repository_id`, `period`, `period_start`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `project_recaps_status_idx`
  ON `project_recaps` (`status`);
