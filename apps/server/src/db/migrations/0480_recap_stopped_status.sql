-- A user Stop was recorded as status 'error' with this exact message; it is now its own status.
UPDATE `project_recaps` SET `status` = 'stopped', `error_message` = NULL
WHERE `status` = 'error' AND `error_message` = 'Cancelled by user';
--> statement-breakpoint
-- A closed window with no activity used to end in this error; it now completes as a quiet recap
-- (RECAP_EMPTY_WINDOW_LEDE, EMPTY_RECAP_STATS). Windows still open keep the error.
UPDATE `project_recaps` SET
  `status` = 'complete',
  `lede` = 'Nothing shipped in this window — no pull requests closed, and none were in flight.',
  `summary_stats` = '{"prCount":0,"mergedCount":0,"closedCount":0,"authorCount":0,"riskBreakdown":{"low":0,"medium":0,"high":0},"walkthroughsMissingCount":0}',
  `source_pr_ids` = '[]',
  `source_walkthrough_ids` = '[]',
  `error_message` = NULL,
  `completed_at` = `generated_at`
WHERE `status` = 'error'
  AND `error_message` = 'No archived or open PRs found for this window'
  AND (
    (`period` = 'daily' AND date(`period_start`) < date('now'))
    OR (`period` = 'weekly' AND date(`period_start`) < date('now', 'weekday 0', '-6 days'))
  );
