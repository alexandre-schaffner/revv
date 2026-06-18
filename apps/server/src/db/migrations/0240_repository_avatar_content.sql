-- Cache the owner avatar bytes as a base64 data URL so the client never
-- depends on an expiring signed `avatar_url` (esp. GitHub Enterprise).
ALTER TABLE `repositories` ADD `avatar_content` text;