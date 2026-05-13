-- Track GitHub's draft status on the PR row so the UI can render
-- owner-specific affordances (Convert to Draft / Mark Ready for Review)
-- without an extra API round-trip. Mapped from the `draft` field returned
-- by GitHub's REST `pulls` endpoint and refreshed on every poll.
--
-- Stored as SQLite integer (0/1), defaulted to 0 so existing rows resolve
-- to "ready for review" on next poll — the upsert path immediately
-- corrects the value from the live PR payload.
ALTER TABLE `pull_requests` ADD COLUMN `is_draft` integer DEFAULT 0 NOT NULL;
