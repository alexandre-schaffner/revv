-- Drop the user_settings table.
--
-- Preferences moved to a JSON file at `~/.revv/settings.json` (see
-- apps/server/src/services/Settings.ts). Single-user, never joined,
-- adding a key shouldn't require a SQL migration — a flat file fits.
--
-- Any preference values written to this table on prior boots are not
-- carried forward; the next read of `~/.revv/settings.json` will create
-- the file with defaults. Acceptable trade-off for a tool that's still
-- pre-1.0 and where the customized field count was small.

DROP TABLE IF EXISTS `user_settings`;
