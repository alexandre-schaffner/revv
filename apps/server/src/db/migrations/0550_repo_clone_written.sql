ALTER TABLE `repositories` ADD `revv_wrote_clone` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Revv wrote every managed clone it finished or was writing, and the
-- "incomplete" folder it refused outside its base is its own clone cut off
-- mid-way: those rows retry instead of staying in error.
UPDATE `repositories` SET `revv_wrote_clone` = 1
WHERE `managed` = 1 AND `clone_path` IS NOT NULL AND (
  `clone_status` IN ('ready', 'cloning')
  OR (`clone_status` = 'pending' AND `clone_error` = 'Server restarted during clone')
  OR (`clone_status` = 'error' AND `clone_error` = 'The clone at that location is incomplete; delete it or choose another.')
);--> statement-breakpoint
ALTER TABLE `pull_requests` DROP COLUMN `review_status`;
