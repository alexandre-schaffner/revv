-- Archive window foundation. Two changes that unblock daily/weekly project
-- recap generation by making "closed/merged PRs in window [T1, T2] with their
-- completed walkthroughs" a fast, correct query:
--
-- 1. Composite index on `pull_requests(repository_id, closed_at)` so the
--    recap pipeline's per-repo windowed query is index-driven instead of
--    scanning every row. Also speeds up the sidebar's archive listing once
--    it grows past the legacy LIMIT 20 ceiling.
--
-- 2. `walkthroughs.completed_at` column. Until now the schema only carried
--    `generated_at` (job start) — there was no reliable way to ask "did this
--    walkthrough finish inside this period?" because we'd have to infer it
--    from `status='complete'` + a timestamp that's actually the start time.
--    The recap scheduler needs the finish time to decide whether a walkthrough
--    is in scope for a period whose window already closed.
--
-- Backfill: existing `status='complete'` rows get `completed_at = generated_at`
-- so the recap pipeline doesn't silently skip historical walkthroughs on first
-- boot. Subsequent transitions to 'complete' stamp `completed_at = now()` in
-- WalkthroughJobs.setStatus (the sole writer of status, per CLAUDE.md
-- invariant #11).

CREATE INDEX IF NOT EXISTS `pull_requests_repo_closed_at_idx`
  ON `pull_requests` (`repository_id`, `closed_at`);
--> statement-breakpoint

ALTER TABLE `walkthroughs` ADD COLUMN `completed_at` text;
--> statement-breakpoint

UPDATE `walkthroughs`
SET `completed_at` = `generated_at`
WHERE `status` = 'complete' AND `completed_at` IS NULL;
