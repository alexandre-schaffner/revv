-- Link AI-authored comment threads back to their source walkthrough issue.
--
-- `walkthrough_issue_id` is null for every human-authored thread and non-null
-- for threads created by the agent via the `add_issue_comment` MCP tool.
-- The cascading FK lets us drop AI comments cleanly when their parent
-- walkthrough_issues row is deleted (which itself cascades from walkthroughs).

ALTER TABLE `comment_threads`
	ADD COLUMN `walkthrough_issue_id` TEXT
	REFERENCES `walkthrough_issues`(`id`) ON DELETE CASCADE;
