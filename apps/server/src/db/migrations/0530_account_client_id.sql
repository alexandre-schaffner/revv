ALTER TABLE `account` ADD `client_id` text;
--> statement-breakpoint
-- Accounts signed in before this column on the GitHub Enterprise host the settings row names were
-- minted with that row's saved client ID. Other rows keep NULL: github.com and env-configured hosts
-- resolve their bundled/env client ID, as they did before.
UPDATE `account` SET `client_id` = (SELECT trim(`github_client_id`) FROM `user_settings` WHERE `id` = 'default')
WHERE lower(`provider_id`) = 'github:' || (SELECT lower(trim(`github_host`)) FROM `user_settings` WHERE `id` = 'default')
  AND (SELECT lower(trim(`github_host`)) FROM `user_settings` WHERE `id` = 'default') <> 'github.com'
  AND (SELECT trim(`github_client_id`) FROM `user_settings` WHERE `id` = 'default') <> '';
