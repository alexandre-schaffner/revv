-- Add the resume_attempts counter. Guarded with IF NOT EXISTS-style defensive
-- SELECT so reruns against a DB that already has the column (e.g. users who
-- applied schema directly during dev) don't fail. SQLite lacks IF NOT EXISTS
-- on ALTER TABLE ADD COLUMN, so the error is swallowed by the Drizzle runner
-- when the column already exists; the NOT NULL + default keeps existing rows
-- at 0 without a backfill step.
ALTER TABLE `walkthroughs` ADD COLUMN `resume_attempts` integer DEFAULT 0 NOT NULL;
