-- One review per pull request. Review sessions used to be keyed on
-- (pull_request_id, mode), with mode derived from who was looking, so one PR's
-- GitHub conversation could be split across an author and a reviewer session.
-- Every PR's sessions (any mode, any status) merge into its oldest one; the
-- rows that hang off a session move with it before the others are deleted,
-- because deleting a session cascades to them.
UPDATE `comment_threads` SET `review_session_id` = (
  SELECT `keep`.`id` FROM `review_sessions` AS `keep`
  WHERE `keep`.`pull_request_id` = (
    SELECT `s`.`pull_request_id` FROM `review_sessions` AS `s`
    WHERE `s`.`id` = `comment_threads`.`review_session_id`
  )
  ORDER BY `keep`.`started_at`, `keep`.`id` LIMIT 1
)
WHERE `review_session_id` IN (SELECT `id` FROM `review_sessions`);
--> statement-breakpoint
UPDATE `walkthroughs` SET `review_session_id` = (
  SELECT `keep`.`id` FROM `review_sessions` AS `keep`
  WHERE `keep`.`pull_request_id` = (
    SELECT `s`.`pull_request_id` FROM `review_sessions` AS `s`
    WHERE `s`.`id` = `walkthroughs`.`review_session_id`
  )
  ORDER BY `keep`.`started_at`, `keep`.`id` LIMIT 1
)
WHERE `review_session_id` IN (SELECT `id` FROM `review_sessions`);
--> statement-breakpoint
UPDATE `review_rounds` SET `review_session_id` = (
  SELECT `keep`.`id` FROM `review_sessions` AS `keep`
  WHERE `keep`.`pull_request_id` = (
    SELECT `s`.`pull_request_id` FROM `review_sessions` AS `s`
    WHERE `s`.`id` = `review_rounds`.`review_session_id`
  )
  ORDER BY `keep`.`started_at`, `keep`.`id` LIMIT 1
)
WHERE `review_session_id` IN (SELECT `id` FROM `review_sessions`);
--> statement-breakpoint
-- Retired table, unique per (session, file, hunk): the kept session's decision wins.
UPDATE OR IGNORE `hunk_decisions` SET `review_session_id` = (
  SELECT `keep`.`id` FROM `review_sessions` AS `keep`
  WHERE `keep`.`pull_request_id` = (
    SELECT `s`.`pull_request_id` FROM `review_sessions` AS `s`
    WHERE `s`.`id` = `hunk_decisions`.`review_session_id`
  )
  ORDER BY `keep`.`started_at`, `keep`.`id` LIMIT 1
)
WHERE `review_session_id` IN (SELECT `id` FROM `review_sessions`);
--> statement-breakpoint
DELETE FROM `hunk_decisions` WHERE `review_session_id` NOT IN (
  SELECT `k`.`id` FROM `review_sessions` AS `k`
  WHERE `k`.`id` = (
    SELECT `k2`.`id` FROM `review_sessions` AS `k2`
    WHERE `k2`.`pull_request_id` = `k`.`pull_request_id`
    ORDER BY `k2`.`started_at`, `k2`.`id` LIMIT 1
  )
);
--> statement-breakpoint
-- A GitHub reply whose root sat in the other session was ingested as a detached
-- thread of its own, so one GitHub thread can now be two local threads. Its
-- messages join the thread holding the GitHub thread's root (the lowest comment
-- id; GitHub ids only grow), and the emptied threads go.
UPDATE `thread_messages` SET `thread_id` = (
  SELECT `c`.`id` FROM `comment_threads` AS `c`, `comment_threads` AS `t`
  WHERE `t`.`id` = `thread_messages`.`thread_id`
    AND `c`.`review_session_id` = `t`.`review_session_id`
    AND `c`.`external_thread_id` = `t`.`external_thread_id`
  ORDER BY `c`.`external_comment_id` IS NULL, CAST(`c`.`external_comment_id` AS INTEGER), `c`.`id`
  LIMIT 1
)
WHERE `thread_id` IN (SELECT `id` FROM `comment_threads` WHERE `external_thread_id` IS NOT NULL);
--> statement-breakpoint
DELETE FROM `comment_threads`
WHERE `external_thread_id` IS NOT NULL
  AND `id` != (
    SELECT `c`.`id` FROM `comment_threads` AS `c`
    WHERE `c`.`review_session_id` = `comment_threads`.`review_session_id`
      AND `c`.`external_thread_id` = `comment_threads`.`external_thread_id`
    ORDER BY `c`.`external_comment_id` IS NULL, CAST(`c`.`external_comment_id` AS INTEGER), `c`.`id`
    LIMIT 1
  );
--> statement-breakpoint
DELETE FROM `review_sessions`
WHERE `id` != (
  SELECT `k`.`id` FROM `review_sessions` AS `k`
  WHERE `k`.`pull_request_id` = `review_sessions`.`pull_request_id`
  ORDER BY `k`.`started_at`, `k`.`id` LIMIT 1
);
--> statement-breakpoint
DROP INDEX `review_sessions_pr_mode_status_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `review_sessions_pull_request_id_unique` ON `review_sessions` (`pull_request_id`);--> statement-breakpoint
ALTER TABLE `review_sessions` DROP COLUMN `mode`;--> statement-breakpoint
ALTER TABLE `review_sessions` DROP COLUMN `completed_at`;--> statement-breakpoint
ALTER TABLE `review_sessions` DROP COLUMN `status`;
