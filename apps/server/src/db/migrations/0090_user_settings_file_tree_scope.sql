-- Adds the sidebar file-tree scope preference to user_settings.
--
-- 'all'    : show every file in the repo at the PR's head SHA, with diff
--            files highlighted (default since the @pierre/trees integration)
-- 'changed': fall back to the pre-tree-software behavior — only files
--            modified by the PR. Useful on slow disks / huge monorepos.
--
-- Default 'all' matches the application-side default in
-- apps/server/src/services/Settings.ts so existing rows behave identically
-- to fresh installs after this migration runs.

ALTER TABLE `user_settings`
	ADD COLUMN `file_tree_scope` TEXT DEFAULT 'all' NOT NULL;
