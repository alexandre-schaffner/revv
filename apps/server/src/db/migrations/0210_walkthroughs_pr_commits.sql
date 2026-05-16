-- Persist the PR commit list on the walkthrough row at job start. The agent
-- fetches it lazily via the `get_commit_history` MCP read tool when it needs
-- to author the "How we got here" journey chapter, instead of paying the
-- ~4.5K prompt tokens up front on every run + resume.
--
-- Stored as JSON of `PrCommit[]` (sha, message first-line, author login,
-- author avatar URL, ISO date). Nullable for backward compatibility with
-- rows created before this migration — those resume with an empty commit
-- list and the agent's single-commit edge-case path kicks in.
ALTER TABLE `walkthroughs` ADD COLUMN `pr_commits` text;
