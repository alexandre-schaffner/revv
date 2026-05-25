-- Drop columns on `project_recaps` that the new structured pipeline left stranded:
--   • `overview`  — legacy markdown blob from the old single-write pipeline.
--                   The new pipeline stores per-PR rows in `recap_pr_entries`
--                   plus a short lede in `lede`. Nothing reads `overview` now.
--   • `total_lines_added` / `total_lines_removed` — cached aggregates that
--                   are trivially `SUM(lines_added)` / `SUM(lines_removed)`
--                   from `recap_pr_entries`. Recomputed on read instead.

ALTER TABLE `project_recaps` DROP COLUMN `overview`;
--> statement-breakpoint
ALTER TABLE `project_recaps` DROP COLUMN `total_lines_added`;
--> statement-breakpoint
ALTER TABLE `project_recaps` DROP COLUMN `total_lines_removed`;
