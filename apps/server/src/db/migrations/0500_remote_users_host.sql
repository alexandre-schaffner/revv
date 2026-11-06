-- A login names a person on one GitHub host: `alice` on github.com and `alice` on a
-- GitHub Enterprise host are different people, and shared one avatar row before this.
ALTER TABLE `remote_users` ADD `host` text DEFAULT 'github.com' NOT NULL;
--> statement-breakpoint
-- Existing rows move to a host the login actually appears on: a repo where it authored a
-- PR, a repo it owns, the account it signed in with, else the first connected host. A
-- login seen on two hosts keeps one row; the other host's avatar is fetched on next sync.
UPDATE `remote_users` SET `host` = COALESCE(
  (SELECT r.`github_host` FROM `pull_requests` p JOIN `repositories` r ON r.`id` = p.`repository_id`
    WHERE p.`author_login` = `remote_users`.`login` LIMIT 1),
  (SELECT r.`github_host` FROM `repositories` r WHERE r.`owner` = `remote_users`.`login` LIMIT 1),
  (SELECT substr(a.`provider_id`, 8) FROM `account` a JOIN `user` u ON u.`id` = a.`user_id`
    WHERE u.`identity_id` = `remote_users`.`id` AND a.`provider_id` LIKE 'github:%' LIMIT 1),
  (SELECT substr(a.`provider_id`, 8) FROM `account` a WHERE a.`provider_id` LIKE 'github:%'
    ORDER BY a.`created_at` LIMIT 1),
  'github.com'
);
--> statement-breakpoint
DROP INDEX IF EXISTS `remote_users_provider_login_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_users_provider_host_login_idx` ON `remote_users` (`provider`,`host`,`login`);
--> statement-breakpoint
-- Repo owner avatars now live here too; carry the bytes `repositories.avatar_content` held.
-- No `last_fetched_at`, so the next metadata refresh re-reads them.
INSERT OR IGNORE INTO `remote_users`
  (`id`, `provider`, `provider_user_id`, `login`, `avatar_content`, `last_avatar_url`, `host`)
SELECT lower(hex(randomblob(16))), 'github', '', r.`owner`, r.`avatar_content`, r.`avatar_url`, r.`github_host`
FROM `repositories` r WHERE r.`avatar_content` IS NOT NULL;
