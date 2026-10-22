ALTER TABLE `walkthroughs` ADD `parent_walkthrough_id` text REFERENCES `walkthroughs`(`id`) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `base_head_sha` text;
--> statement-breakpoint
ALTER TABLE `walkthroughs` ADD `generation_mode` text DEFAULT 'full' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `walkthroughs_pr_head_sha_unique`;
--> statement-breakpoint
DROP INDEX IF EXISTS `walkthroughs_pr_head_sha_mode_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `walkthroughs_active_pr_head_sha_unique`
  ON `walkthroughs` (`pull_request_id`, `pr_head_sha`, `mode`, `generation_mode`)
  WHERE `status` <> 'superseded';
--> statement-breakpoint
CREATE TABLE `review_rounds` (
  `id` text PRIMARY KEY NOT NULL,
  `pull_request_id` text NOT NULL,
  `review_session_id` text NOT NULL,
  `walkthrough_id` text NOT NULL,
  `previous_walkthrough_id` text,
  `round_number` integer NOT NULL,
  `kind` text DEFAULT 'full' NOT NULL,
  `visibility` text DEFAULT 'visible' NOT NULL,
  `status` text DEFAULT 'generating' NOT NULL,
  `from_sha` text,
  `to_sha` text NOT NULL,
  `created_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`review_session_id`) REFERENCES `review_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`walkthrough_id`) REFERENCES `walkthroughs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`previous_walkthrough_id`) REFERENCES `walkthroughs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `review_rounds_pr_round_idx`
  ON `review_rounds` (`pull_request_id`, `round_number`);
--> statement-breakpoint
CREATE INDEX `review_rounds_walkthrough_idx`
  ON `review_rounds` (`walkthrough_id`);
