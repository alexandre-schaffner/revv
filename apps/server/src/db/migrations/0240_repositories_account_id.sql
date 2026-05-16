-- Add account_id to repositories and enforce per-account uniqueness.
--
-- Repositories are now owned by a specific connected GitHub account (not just
-- the local user). This lets the same repo exist on both github.com and a GHE
-- instance when the user has linked both accounts.

-- 1. Add the column (nullable at first — backfilled next).
ALTER TABLE `repositories` ADD COLUMN `account_id` TEXT REFERENCES `account`(`id`) ON DELETE CASCADE;
--> statement-breakpoint

-- 2. Backfill: map each repo to the account whose providerId matches the host.
--    Order matters: prefer the host-specific providerId, fall back to legacy 'github'.
UPDATE `repositories`
SET `account_id` = (
  SELECT a.id FROM account a
  WHERE (
    a.provider_id = 'github:' || repositories.github_host
    OR (repositories.github_host = 'github.com' AND a.provider_id = 'github')
  )
  ORDER BY CASE WHEN a.provider_id = 'github:' || repositories.github_host THEN 0 ELSE 1 END
  LIMIT 1
);
--> statement-breakpoint

-- 3. Any rows that still don't have an account_id belong to a user whose
--    account row predates the host-keyed providerId convention.  Pick the
--    first 'github' account as a last-ditch backfill.
UPDATE `repositories`
SET `account_id` = (
  SELECT a.id FROM account a
  WHERE a.provider_id = 'github'
  LIMIT 1
)
WHERE `account_id` IS NULL;
--> statement-breakpoint

-- 4. Drop the old global unique index on full_name alone.
DROP INDEX IF EXISTS `uq_repositories_full_name`;
--> statement-breakpoint

-- 5. Create the new per-account unique index.
CREATE UNIQUE INDEX IF NOT EXISTS `uq_repositories_full_name_account`
  ON `repositories` (`full_name`, `account_id`);
--> statement-breakpoint

-- 6. Recreate the table with account_id NOT NULL so Drizzle's schema matches.
--    SQLite doesn't support ALTER COLUMN, so we copy-and-swap.
CREATE TABLE `repositories_new` (
  `id` text PRIMARY KEY NOT NULL,
  `provider` text NOT NULL DEFAULT 'github',
  `owner` text NOT NULL,
  `name` text NOT NULL,
  `full_name` text NOT NULL,
  `default_branch` text NOT NULL DEFAULT 'main',
  `avatar_url` text,
  `added_at` text NOT NULL,
  `clone_status` text NOT NULL DEFAULT 'pending',
  `clone_path` text,
  `clone_error` text,
  `github_host` text NOT NULL,
  `account_id` text NOT NULL REFERENCES `account`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint

INSERT INTO `repositories_new` SELECT * FROM `repositories`;
--> statement-breakpoint

DROP TABLE `repositories`;
--> statement-breakpoint

ALTER TABLE `repositories_new` RENAME TO `repositories`;
--> statement-breakpoint

-- 7. Recreate the per-account unique index on the new table.
CREATE UNIQUE INDEX IF NOT EXISTS `uq_repositories_full_name_account`
  ON `repositories` (`full_name`, `account_id`);
