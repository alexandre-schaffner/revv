-- Walkthrough phases refactor — encode the A→B→C→D doctrine into the schema.
--
-- See "Agent Subsystem Invariants" in CLAUDE.md. This migration adds:
--   1. `walkthroughs.last_completed_phase` — orchestrator-owned phase pointer.
--   2. `walkthroughs.sentiment` — first-class Phase C field (replaces the old
--      "Overall Sentiment" markdown-by-convention block).
--   3. `walkthroughs.superseded_by` — self-FK for immutable-per-SHA versioning.
--   4. Extended status enum: adds `'superseded'` (enforced by application only —
--      SQLite has no native enum type).
--   5. UNIQUE INDEX on (pull_request_id, pr_head_sha) — makes startJob
--      naturally idempotent.
--   6. `walkthrough_blocks.phase` + `walkthrough_blocks.step_index` + UNIQUE
--      INDEX on (walkthrough_id, phase, step_index) — one row per Phase B step.
--
-- Backfill strategy:
--   - Existing `complete` walkthroughs → last_completed_phase = 'D'.
--   - Existing `generating` → 'none' (will be re-derived by resume).
--   - Existing `error` → whatever-you-had-before (still 'none'; these rows are
--     being abandoned anyway, and the old data structure had no phase pointer).
--   - Existing blocks → phase = 'diff_analysis', step_index = order.
--   - Existing "Overall Sentiment" markdown blocks → migrated to
--     walkthroughs.sentiment AND the block row is kept as-is (we do not delete
--     legacy blocks; the frontend will prefer `sentiment` when set and skip
--     duplicate "## Overall Sentiment" markdown blocks for rendering).
--
-- SQLite lacks IF NOT EXISTS on ALTER TABLE ADD COLUMN; Drizzle's migrator
-- swallows "duplicate column name" errors per the 0050 precedent.

ALTER TABLE `walkthroughs` ADD COLUMN `last_completed_phase` text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD COLUMN `sentiment` text;
--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD COLUMN `superseded_by` text REFERENCES `walkthroughs`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `walkthrough_blocks` ADD COLUMN `phase` text NOT NULL DEFAULT 'diff_analysis';
--> statement-breakpoint
ALTER TABLE `walkthrough_blocks` ADD COLUMN `step_index` integer;
--> statement-breakpoint

-- Backfill: complete walkthroughs are at Phase D.
UPDATE `walkthroughs`
SET `last_completed_phase` = 'D'
WHERE `status` = 'complete';
--> statement-breakpoint

-- Backfill: block step_index = order for Phase B blocks (all existing blocks
-- default to phase='diff_analysis' via the column default above).
UPDATE `walkthrough_blocks`
SET `step_index` = `order`
WHERE `step_index` IS NULL AND `phase` = 'diff_analysis';
--> statement-breakpoint

-- Backfill: promote "Overall Sentiment" markdown blocks to walkthroughs.sentiment.
-- We extract the markdown content JSON field from the block data and set the
-- walkthrough's sentiment column. Existing block rows are left in place — the
-- frontend will prefer the column value and skip rendering duplicates.
-- json_extract is safe against non-JSON data (returns NULL).
UPDATE `walkthroughs`
SET `sentiment` = (
	SELECT json_extract(b.data, '$.content')
	FROM `walkthrough_blocks` AS b
	WHERE b.walkthrough_id = walkthroughs.id
	  AND b.type = 'markdown'
	  AND TRIM(json_extract(b.data, '$.content')) LIKE '## Overall Sentiment%'
	ORDER BY b."order" ASC
	LIMIT 1
)
WHERE `sentiment` IS NULL;
--> statement-breakpoint

-- Unique indexes — created last so backfill-induced transient duplicates (if
-- any) don't block the schema change. Each index is the schema-level anchor
-- for a doctrine invariant.

-- One walkthrough per (PR, head_sha). Makes startJob idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS `walkthroughs_pr_head_sha_unique`
  ON `walkthroughs` (`pull_request_id`, `pr_head_sha`);
--> statement-breakpoint

-- One block row per Phase B step. Makes add_diff_step idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS `walkthrough_blocks_phase_step_unique`
  ON `walkthrough_blocks` (`walkthrough_id`, `phase`, `step_index`);
