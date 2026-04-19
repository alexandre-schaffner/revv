-- Capture the commenter's GitHub avatar URL on each thread message so the
-- review UI can render real faces instead of a generic User icon. Nullable
-- on purpose: (a) ai_agent messages legitimately have no avatar, (b) rows
-- synced before this migration won't have a URL until the next sync pass
-- backfills them. SQLite lacks IF NOT EXISTS on ALTER TABLE ADD COLUMN, so
-- the Drizzle runner will swallow the error if a dev already applied the
-- column directly.
ALTER TABLE `thread_messages` ADD COLUMN `author_avatar_url` text;
