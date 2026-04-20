-- Track which walkthrough issues the reviewer already posted to GitHub so the
-- "already sent" treatment (grayed-out row, unchecked checkbox) survives app
-- restarts. Previously this lived in a module-level Map in RequestChanges.svelte
-- and was lost on every reload / session switch.
--
-- Nullable text: `null` means "never submitted"; an ISO 8601 timestamp means
-- "submitted at this time." SQLite lacks IF NOT EXISTS on ALTER TABLE ADD
-- COLUMN, so the Drizzle runner will swallow the error if a dev applied the
-- column directly during development.
ALTER TABLE `walkthrough_issues` ADD COLUMN `submitted_at` text;
