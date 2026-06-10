## Shared walkthrough task

Review the current pull request using the selected mode's instructions and the strict MCP pipeline from the system prompt. Base the review on the current diff and any repository context you explicitly inspect with tools.

Commit history is intentionally not inlined here. The orchestrator persists it on the walkthrough row at job start; the selected mode's prompt tells you whether to fetch it through `get_commit_history`.
