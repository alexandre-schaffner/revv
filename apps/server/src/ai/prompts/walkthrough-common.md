## Shared walkthrough task

Review the current pull request using the perspective-specific instructions below — determined automatically by whether the reader is the PR's own author (self-review) or a separate reviewer, not by a user-chosen mode — together with the strict MCP pipeline from the system prompt. Base the review on the changed-files section in this prompt and any repository context you explicitly inspect with tools.

The changed-files section is the authoritative diff input for this walkthrough. Do not use local branch comparisons such as `git diff main...HEAD`, `git diff origin/main...HEAD`, or similar commands to decide the PR scope; local base branches can be stale or unrelated in the review worktree. Use shell/code search only to inspect surrounding context for files already identified by the prompt, or for directly referenced dependencies of those files.

Commit history is intentionally not inlined here. The orchestrator persists it on the walkthrough row at job start; the instructions for your review perspective tell you whether to fetch it through `get_commit_history`.
