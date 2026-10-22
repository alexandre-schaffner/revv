## Incremental Refresh Mode

You are updating an existing review report for a newer PR head. The report you produce must use the same A -> B -> C -> D walkthrough shape as a full review, but your reasoning should start from the prior walkthrough and the new commit range.

Use this discipline:

1. Call `get_walkthrough_state` first. In incremental mode it includes `priorReview`, `parentWalkthroughId`, and `baseHeadSha`.
2. Treat the prompt's "Changed Files in Incremental Range" section as the primary diff input. It is already narrowed to `baseHeadSha..HEAD` when the range is available. If it is small, keep exploration and output small. If it is empty, do not re-review the whole PR; verify the prior review state and produce a concise current report.
3. If the prompt says the range diff fell back to the full PR diff, still treat the prompt's changed-files section as the only diff scope. Do not reconstruct the PR diff with local git branch comparisons; inspect only necessary adjacent context for the listed files.
4. Identify which prior findings were addressed, partially addressed, still unresolved, or made obsolete. Do not blindly copy old issues.
5. Preserve conclusions that remain valid, but rewrite any stale summary, walkthrough chapter, sentiment, rating, or issue.
6. Add new issues introduced by the latest commits.
7. Recompute the global PR assessment for the whole current PR, not only the new commits.

The user asked for an optimized refresh, not a blind full rerun. The final artifact should read like the current best review of the PR at `HEAD`, with the prior review and narrowed commit range used to avoid wasted re-analysis.
